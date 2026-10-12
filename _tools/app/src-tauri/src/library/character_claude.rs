//! Claude decides the easy 확인-list recommendations (CHAR-CLAUDE-001, PC only).
//!
//! Every open (character, image) pair the PC 확인 list can show -- pending tag pairs, S36
//! candidates (folded ones included) and S36 doubtful placements -- goes through a cascade:
//! Haiku says yes -> accept; otherwise Sonnet says no -> reject, or yes with confidence of at
//! least [`SONNET_ACCEPT_CONFIDENCE`] -> accept; anything else is left to the person.
//!
//! Decisions are ordinary `origin='automatic'` rows whose snapshot names the engine `claude`.
//! They hide the pair from every review list ([`settled_pairs`], the tagger pending view), are
//! never learning examples and never count as a person's judgment (those queries read
//! `origin='manual'` only); a later manual decision is the newest row and replaces them.
//!
//! The run is a background step of the idle native owner (`character_incremental`): one pair
//! per idle turn, never in lightweight (saver) mode, never holding the library connection
//! while images are encoded or the network is used.
use super::{
    characters::{Error, Reference, Result},
    ingestion::decode_oriented_image,
    Library,
};
use chrono::{DateTime, Datelike, Local, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    time::{Duration, Instant},
};

pub const HAIKU: &str = "claude-haiku-5-5";
pub const SONNET: &str = "claude-sonnet-5-5";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
/// The one question both models are asked (their only difference is the model name).
pub(super) const QUESTION: &str = "Does the candidate image depict the same character as the reference images? Judge character identity (the same individual character), not merely similar art style, hair colour or colour palette. Costume, outfit and hairstyle changes are allowed. Answer yes, no or unsure, with a confidence between 0 and 1 and a short reason.";
const MAX_REFERENCES: usize = 4;
const MAX_IMAGE_EDGE: u32 = 1568;
const JPEG_QUALITY: u8 = 85;
const MAX_REASON_CHARS: usize = 500;
const MAX_RESPONSE_BYTES: usize = 1 << 20;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_RETRIES: usize = 2;
const DEFAULT_RETRY_WAIT: Duration = Duration::from_secs(10);
const MAX_RETRY_WAIT: Duration = Duration::from_secs(60);
/// Sonnet's yes must be this sure to place an image without a person.
pub const SONNET_ACCEPT_CONFIDENCE: f64 = 0.9;
/// Pairs that fail on the network in a row before the run ends and waits for a later retry.
const MAX_TRANSIENT_STREAK: u32 = 3;
const RETRY_LATER: Duration = Duration::from_secs(600);
const RUNNING_FRESH: Duration = Duration::from_secs(60);
/// US dollars per million tokens: (input, output).
const HAIKU_PRICE: (f64, f64) = (0.10, 0.50);
const SONNET_PRICE: (f64, f64) = (2.0, 10.0);
pub const DEFAULT_MONTHLY_CAP_USD: f64 = 10.0;

// ---------------------------------------------------------------------------------------------
// Pure pieces: opinions, the cascade, cost, reference key, request and response shapes.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Verdict {
    Yes,
    No,
    Unsure,
    Refused,
}

impl Verdict {
    fn stored(self) -> &'static str {
        match self {
            Self::Yes => "yes",
            Self::No => "no",
            Self::Unsure => "unsure",
            Self::Refused => "refused",
        }
    }
    fn from_stored(value: &str) -> Option<Self> {
        Some(match value {
            "yes" => Self::Yes,
            "no" => Self::No,
            "unsure" => Self::Unsure,
            "refused" => Self::Refused,
            _ => return None,
        })
    }
}

/// What one model answered about one pair.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Opinion {
    pub verdict: Verdict,
    pub confidence: Option<f64>,
    pub reason: Option<String>,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_write_tokens: u32,
    pub cache_read_tokens: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Outcome {
    Accept,
    Reject,
    Leave,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Step {
    AskHaiku,
    AskSonnet,
    Done(Outcome),
}

/// The cascade. Haiku yes accepts; otherwise Sonnet decides: no rejects, a sure yes accepts,
/// anything else (unsure, a less sure yes, a refusal) stays for the person.
pub(super) fn cascade(haiku: Option<&Opinion>, sonnet: Option<&Opinion>) -> Step {
    let Some(haiku) = haiku else {
        return Step::AskHaiku;
    };
    if haiku.verdict == Verdict::Yes {
        return Step::Done(Outcome::Accept);
    }
    let Some(sonnet) = sonnet else {
        return Step::AskSonnet;
    };
    Step::Done(match sonnet.verdict {
        Verdict::No => Outcome::Reject,
        Verdict::Yes if sonnet.confidence.unwrap_or(0.0) >= SONNET_ACCEPT_CONFIDENCE => {
            Outcome::Accept
        }
        _ => Outcome::Leave,
    })
}

fn price(model: &str) -> (f64, f64) {
    if model == HAIKU {
        HAIKU_PRICE
    } else {
        SONNET_PRICE
    }
}

/// Dollars one answer cost.
pub(super) fn cost_usd(
    model: &str,
    input_tokens: u32,
    output_tokens: u32,
    cache_write_tokens: u32,
    cache_read_tokens: u32,
) -> f64 {
    let (input, output) = price(model);
    ((f64::from(input_tokens)
        + 1.25 * f64::from(cache_write_tokens)
        + 0.1 * f64::from(cache_read_tokens))
        * input
        + f64::from(output_tokens) * output)
        / 1_000_000.0
}

/// Lowercase hex SHA-256 of the newline-joined content hashes of the references sent, in slot
/// order: it names the evidence an opinion was given on.
pub(super) fn reference_key<'a>(hashes: impl IntoIterator<Item = &'a str>) -> String {
    let joined = hashes.into_iter().collect::<Vec<_>>().join("\n");
    Sha256::digest(joined.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
pub(super) fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(BASE64[(n >> 18) as usize & 63] as char);
        out.push(BASE64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            BASE64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn text_block(text: &str) -> Value {
    json!({"type": "text", "text": text})
}

fn image_block(jpeg_base64: &str) -> Value {
    json!({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": jpeg_base64}})
}

/// The user message content: each reference named and shown, then the candidate, then the
/// question.
pub(super) fn message_content(
    references: &[(String, String)],
    display_name: &str,
    series_name: Option<&str>,
    candidate: &str,
) -> Vec<Value> {
    let series = series_name
        .filter(|name| !name.is_empty())
        .unwrap_or("unknown series");
    let mut content = Vec::with_capacity(references.len() * 2 + 3);
    for (index, (_, data)) in references.iter().enumerate() {
        content.push(text_block(&format!(
            "Reference {}: {display_name} ({series})",
            index + 1
        )));
        let mut block = image_block(data);
        if index + 1 == references.len() {
            block["cache_control"] = json!({"type": "ephemeral"});
        }
        content.push(block);
    }
    content.push(text_block("Candidate:"));
    content.push(image_block(candidate));
    content.push(text_block(QUESTION));
    content
}

/// The request body; only `model` differs between the two models. No `thinking`,
/// `temperature`, `top_p`, `tool_choice` or `fallbacks` is ever sent.
pub(super) fn request_body(model: &str, content: &[Value]) -> Value {
    json!({
        "model": model,
        "max_tokens": 2000,
        "output_config": {
            "effort": "low",
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": {
                        "same_character": {"type": "string", "enum": ["yes", "no", "unsure"]},
                        "confidence": {"type": "number"},
                        "reason": {"type": "string"}
                    },
                    "required": ["same_character", "confidence", "reason"],
                    "additionalProperties": false
                }
            }
        },
        "messages": [{"role": "user", "content": content}]
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CallError {
    /// 401/403: the key is wrong or revoked.
    Auth,
    /// 429, 5xx or no connection, after the retries.
    Transient,
    /// Anything else: an unusable answer or a request the API refused to take.
    Invalid,
    Cancelled,
}

fn tokens(usage: &Value, field: &str) -> u32 {
    usage[field]
        .as_u64()
        .map_or(0, |count| u32::try_from(count).unwrap_or(u32::MAX))
}

/// Reads one Messages API answer. `stop_reason` comes first: a refusal is an answer (and is
/// billed), a truncated one is an error.
pub(super) fn parse_message(body: &str) -> std::result::Result<Opinion, CallError> {
    let message: Value = serde_json::from_str(body).map_err(|_| CallError::Invalid)?;
    let (input_tokens, output_tokens) = (
        tokens(&message["usage"], "input_tokens"),
        tokens(&message["usage"], "output_tokens"),
    );
    let cache_write_tokens = tokens(&message["usage"], "cache_creation_input_tokens");
    let cache_read_tokens = tokens(&message["usage"], "cache_read_input_tokens");
    match message["stop_reason"].as_str() {
        Some("refusal") => {
            return Ok(Opinion {
                verdict: Verdict::Refused,
                confidence: None,
                reason: None,
                input_tokens,
                output_tokens,
                cache_write_tokens,
                cache_read_tokens,
            })
        }
        Some("max_tokens") => return Err(CallError::Invalid),
        _ => {}
    }
    let text = message["content"]
        .as_array()
        .and_then(|blocks| blocks.iter().find(|block| block["type"] == "text"))
        .and_then(|block| block["text"].as_str())
        .ok_or(CallError::Invalid)?;
    let answer: Value = serde_json::from_str(text).map_err(|_| CallError::Invalid)?;
    let verdict = match answer["same_character"].as_str() {
        Some("yes") => Verdict::Yes,
        Some("no") => Verdict::No,
        Some("unsure") => Verdict::Unsure,
        _ => return Err(CallError::Invalid),
    };
    let confidence = answer["confidence"]
        .as_f64()
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0));
    let reason = answer["reason"]
        .as_str()
        .map(|reason| reason.chars().take(MAX_REASON_CHARS).collect::<String>());
    Ok(Opinion {
        verdict,
        confidence,
        reason,
        input_tokens,
        output_tokens,
        cache_write_tokens,
        cache_read_tokens,
    })
}

/// A JPEG for the model: orientation applied by the decoder, shrunk to fit the edge limit
/// (never enlarged), flattened over white, quality 85.
pub(super) fn jpeg_for_model(image: image::DynamicImage) -> Option<Vec<u8>> {
    let (width, height) = (image.width(), image.height());
    if width == 0 || height == 0 {
        return None;
    }
    let image = if width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE {
        image.resize(
            MAX_IMAGE_EDGE,
            MAX_IMAGE_EDGE,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        image
    };
    let rgba = image.to_rgba8();
    let mut rgb = Vec::with_capacity(rgba.pixels().len() * 3);
    for pixel in rgba.pixels() {
        let alpha = u32::from(pixel[3]);
        for channel in 0..3 {
            let value = (u32::from(pixel[channel]) * alpha + 255 * (255 - alpha)) / 255;
            rgb.push(value as u8);
        }
    }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode(
            &rgb,
            rgba.width(),
            rgba.height(),
            image::ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(jpeg)
}

/// The first day of the local calendar month containing `now`, as the UTC instant the stored
/// timestamps compare against.
pub(super) fn month_start(now: DateTime<Local>) -> String {
    let first = now
        .date_naive()
        .with_day(1)
        .and_then(|day| day.and_hms_opt(0, 0, 0))
        .unwrap_or_else(|| now.naive_local());
    Local
        .from_local_datetime(&first)
        .earliest()
        .unwrap_or(now)
        .with_timezone(&Utc)
        .to_rfc3339()
}

fn month_label(now: DateTime<Local>) -> String {
    format!("{}-{:02}", now.year(), now.month())
}

// ---------------------------------------------------------------------------------------------
// Transport.
// ---------------------------------------------------------------------------------------------

#[derive(Debug)]
pub(super) struct Reply {
    pub status: u16,
    pub retry_after: Option<Duration>,
    pub body: String,
}

/// The network below the Messages API; tests replace it.
pub(super) trait Transport: Send + Sync {
    /// One POST. `Err` is a failure to connect, send or read (never an HTTP status).
    fn post(&self, api_key: &str, body: &[u8]) -> std::result::Result<Reply, ()>;
    /// Waits before a retry; stops early when `stop` is set.
    fn pause(&self, wait: Duration, stop: &AtomicBool) {
        let end = Instant::now() + wait;
        while Instant::now() < end && !stop.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

/// HTTPS only, no redirects, a bounded body and a 90 s limit, like the other provider clients.
struct HttpTransport {
    agent: ureq::Agent,
}

fn http_transport() -> &'static HttpTransport {
    static TRANSPORT: OnceLock<HttpTransport> = OnceLock::new();
    TRANSPORT.get_or_init(|| HttpTransport {
        agent: ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_TIMEOUT))
            .build()
            .into(),
    })
}

impl Transport for HttpTransport {
    fn post(&self, api_key: &str, body: &[u8]) -> std::result::Result<Reply, ()> {
        let mut response = self
            .agent
            .post(API_URL)
            .header("x-api-key", api_key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .send(body)
            .map_err(|_| ())?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take((MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(());
        }
        Ok(Reply {
            status,
            retry_after,
            body: String::from_utf8(bytes).map_err(|_| ())?,
        })
    }
}

struct Runner<'a> {
    transport: &'a dyn Transport,
    api_key: &'a str,
    stop: &'a AtomicBool,
}

impl Runner<'_> {
    /// One question to one model with the back-off rules: 429, 5xx and connection failures
    /// wait for `retry-after` (10 s without it) and try again, twice at most.
    fn ask(&self, model: &str, content: &[Value]) -> std::result::Result<Opinion, CallError> {
        let body =
            serde_json::to_vec(&request_body(model, content)).map_err(|_| CallError::Invalid)?;
        for attempt in 0..=MAX_RETRIES {
            if self.stop.load(Ordering::Acquire) {
                return Err(CallError::Cancelled);
            }
            let wait = match self.transport.post(self.api_key, &body) {
                Ok(reply) => match reply.status {
                    200 => return parse_message(&reply.body),
                    401 | 403 => return Err(CallError::Auth),
                    429 | 500..=599 => reply
                        .retry_after
                        .unwrap_or(DEFAULT_RETRY_WAIT)
                        .min(MAX_RETRY_WAIT),
                    _ => return Err(CallError::Invalid),
                },
                Err(()) => DEFAULT_RETRY_WAIT,
            };
            if attempt == MAX_RETRIES {
                return Err(CallError::Transient);
            }
            self.transport.pause(wait, self.stop);
        }
        Err(CallError::Transient)
    }
}

// ---------------------------------------------------------------------------------------------
// Settings, status and the shared run state.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettings {
    pub enabled: bool,
    pub monthly_cap_usd: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    /// `off`, `no_key`, `idle`, `running`, `capped`, `credential` or `error`.
    pub state: &'static str,
    pub done: usize,
    pub total: usize,
    pub spent_usd: f64,
    pub cap_usd: f64,
    pub auto_accepted: i64,
    pub auto_rejected: i64,
    pub left_for_user: i64,
    pub last_run_at: Option<String>,
}

/// One pair waiting for Claude, with what it is judged on.
#[derive(Debug, Clone)]
pub(super) struct QueuedPair {
    target_id: String,
    asset_id: String,
    asset_hash: String,
    relative_path: String,
    display_name: String,
    series_name: Option<String>,
    reference_key: String,
    references: Vec<SentReference>,
}

#[derive(Debug, Clone)]
struct SentReference {
    reference: Reference,
    relative_path: String,
}

#[derive(Debug, Default)]
pub(super) struct State {
    /// Settings and key were read since the last [`Library::claude_poke`].
    checked: bool,
    /// Off or without a key: nothing to do until a poke.
    dormant: bool,
    credential_error: bool,
    error: bool,
    capped_month: Option<String>,
    retry_at: Option<Instant>,
    dirty: bool,
    built_marker: Option<String>,
    queue: VecDeque<QueuedPair>,
    active: bool,
    total: usize,
    done: usize,
    transient_streak: u32,
    /// When the run last made progress; a queue that has stood still for a minute (saver mode,
    /// a busier owner) is not shown as running.
    progress_at: Option<Instant>,
    last_run_at: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum PairResult {
    Accepted,
    Rejected,
    Left,
    Skipped,
}

#[derive(Debug, PartialEq, Eq)]
enum Flow {
    Done(PairResult),
    /// The monthly cap is reached.
    Capped,
    /// The key was refused.
    Credential,
    Cancelled,
    /// The network failed; the pair is skipped for this run.
    Transient,
}

/// Pairs whose newest decision is one Claude made (accepted or rejected). The review lists
/// leave them out. `pairs` is a JSON array of `[target_id, source_asset_id]`.
pub(super) fn settled_pairs(c: &Connection, pairs: &str) -> Result<BTreeSet<(String, String)>> {
    Ok(c.prepare(
        "SELECT json_extract(requested.value,'$[0]'),json_extract(requested.value,'$[1]')
         FROM json_each(?1) requested
         JOIN character_decisions d ON d.sequence=(
              SELECT x.sequence FROM character_decisions x
              WHERE x.target_id=json_extract(requested.value,'$[0]')
                AND x.source_asset_id=json_extract(requested.value,'$[1]')
              ORDER BY x.sequence DESC LIMIT 1)
         WHERE d.origin='automatic' AND d.decision IN ('accepted','rejected')
           AND json_valid(d.reference_snapshot)
           AND COALESCE(json_extract(d.reference_snapshot,'$.prediction.engine'),'')='claude'",
    )?
    .query_map([pairs], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?
    .collect::<std::result::Result<_, _>>()?)
}

fn load_opinion(
    c: &Connection,
    target_id: &str,
    asset_hash: &str,
    key: &str,
    model: &str,
) -> Result<Option<Opinion>> {
    Ok(c.query_row(
        "SELECT verdict,confidence,reason,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens FROM character_claude_opinions
         WHERE target_id=?1 AND asset_hash=?2 AND reference_key=?3 AND model=?4",
        params![target_id, asset_hash, key, model],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<f64>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, u32>(3)?,
                row.get::<_, u32>(4)?,
                row.get::<_, u32>(5)?,
                row.get::<_, u32>(6)?,
            ))
        },
    )
    .optional()?
    .and_then(
        |(verdict, confidence, reason, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens)| {
            Some(Opinion {
                verdict: Verdict::from_stored(&verdict)?,
                confidence,
                reason,
                input_tokens,
                output_tokens,
                cache_write_tokens,
                cache_read_tokens,
            })
        },
    ))
}

fn spend_usd(c: &Connection, since: &str) -> Result<f64> {
    let rows = c
        .prepare(
            "SELECT model,SUM(input_tokens),SUM(output_tokens),SUM(cache_write_tokens),SUM(cache_read_tokens) FROM character_claude_opinions
             WHERE created_at>=?1 GROUP BY model",
        )?
        .query_map([since], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .map(|(model, input, output, cache_write, cache_read)| {
            cost_usd(
                &model,
                u32::try_from(input).unwrap_or(u32::MAX),
                u32::try_from(output).unwrap_or(u32::MAX),
                u32::try_from(cache_write).unwrap_or(u32::MAX),
                u32::try_from(cache_read).unwrap_or(u32::MAX),
            )
        })
        .sum())
}

fn reject_in(
    library: &Library,
    tx: &Connection,
    target: &super::characters::Target,
    asset_id: &str,
    asset_hash: &str,
    snapshot: &Value,
) -> Result<()> {
    tx.execute(
        "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
         VALUES(?1,?2,?2,?3,'rejected',?4,?5,'automatic',?6)",
        params![
            target.id,
            asset_id,
            asset_hash,
            target.fingerprint,
            serde_json::to_string(snapshot)?,
            Utc::now().to_rfc3339()
        ],
    )?;
    super::character_autotag::refresh_character_review_state(tx, asset_id)?;
    library
        .character_changes
        .series_analysed(target.series_classification_id.as_deref());
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The library side.
// ---------------------------------------------------------------------------------------------

impl Library {
    pub fn claude_settings(&self) -> Result<ClaudeSettings> {
        Ok(self.connection()?.query_row(
            "SELECT enabled,monthly_cap_usd FROM character_claude_settings WHERE singleton=1",
            [],
            |row| {
                Ok(ClaudeSettings {
                    enabled: row.get(0)?,
                    monthly_cap_usd: row.get(1)?,
                })
            },
        )?)
    }

    pub fn set_claude_settings(
        &self,
        enabled: bool,
        monthly_cap_usd: f64,
    ) -> Result<ClaudeSettings> {
        if !monthly_cap_usd.is_finite() || !(0.0..=100_000.0).contains(&monthly_cap_usd) {
            return Err(Error::Invalid("월 한도가 올바르지 않습니다."));
        }
        self.connection()?.execute(
            "UPDATE character_claude_settings SET enabled=?1,monthly_cap_usd=?2 WHERE singleton=1",
            params![enabled, monthly_cap_usd],
        )?;
        self.claude_poke();
        Ok(ClaudeSettings {
            enabled,
            monthly_cap_usd,
        })
    }

    /// Settings, the key or the month changed: look again and wake the idle owner.
    pub fn claude_poke(&self) {
        {
            let mut state = self.claude_state();
            state.checked = false;
            state.dirty = true;
            state.credential_error = false;
            state.error = false;
            state.capped_month = None;
            state.retry_at = None;
            state.transient_streak = 0;
        }
        self.character_wake.notify();
    }

    fn claude_state(&self) -> std::sync::MutexGuard<'_, State> {
        self.character_claude
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Month figures and the current run, for the settings screen.
    pub fn claude_status(&self, key_present: bool) -> Result<ClaudeStatus> {
        let settings = self.claude_settings()?;
        let since = month_start(Local::now());
        let c = self.connection()?;
        let spent = spend_usd(&c, &since)?;
        let claude_decisions = |decision: &str| -> Result<i64> {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM character_decisions
                 WHERE origin='automatic' AND decision=?1 AND created_at>=?2
                   AND json_valid(reference_snapshot)
                   AND COALESCE(json_extract(reference_snapshot,'$.prediction.engine'),'')='claude'",
                params![decision, since],
                |row| row.get(0),
            )?)
        };
        let (auto_accepted, auto_rejected) =
            (claude_decisions("accepted")?, claude_decisions("rejected")?);
        // Pairs Sonnet looked at last and could not settle, still without a newer decision.
        let left_for_user: i64 = c.query_row(
            "SELECT COUNT(*) FROM character_claude_opinions o
             WHERE o.model=?1
               AND o.created_at=(SELECT MAX(x.created_at) FROM character_claude_opinions x
                                 WHERE x.target_id=o.target_id AND x.asset_hash=o.asset_hash AND x.model=?1)
               AND (o.verdict IN ('unsure','refused')
                    OR (o.verdict='yes' AND COALESCE(o.confidence,0)<?2))
               AND NOT EXISTS(SELECT 1 FROM character_decisions d
                              WHERE d.target_id=o.target_id AND d.asset_hash=o.asset_hash
                                AND d.decision IN ('accepted','rejected') AND d.created_at>=o.created_at)",
            params![SONNET, SONNET_ACCEPT_CONFIDENCE],
            |row| row.get(0),
        )?;
        let last_run_db: Option<String> = c.query_row(
            "SELECT MAX(created_at) FROM character_claude_opinions",
            [],
            |row| row.get(0),
        )?;
        drop(c);
        let state = self.claude_state();
        let status = if !settings.enabled {
            "off"
        } else if !key_present {
            "no_key"
        } else if state.credential_error {
            "credential"
        } else if state.active
            || (!state.queue.is_empty()
                && state
                    .progress_at
                    .is_some_and(|at| at.elapsed() < RUNNING_FRESH))
        {
            "running"
        } else if spent >= settings.monthly_cap_usd {
            "capped"
        } else if state.error {
            "error"
        } else {
            "idle"
        };
        Ok(ClaudeStatus {
            state: status,
            done: state.done,
            total: state.total,
            spent_usd: spent,
            cap_usd: settings.monthly_cap_usd,
            auto_accepted,
            auto_rejected,
            left_for_user,
            last_run_at: state.last_run_at.clone().or(last_run_db),
        })
    }

    // -- Open pairs ------------------------------------------------------------------------

    /// Everything the PC 확인 list can show, each pair once: tag pairs, S36 candidates (folded
    /// ones included) and S36 doubtful placements, in that order.
    fn claude_open_pairs(&self) -> Result<Vec<(String, String)>> {
        let mut seen = BTreeSet::new();
        let mut pairs = Vec::new();
        let mut add = |target: String, asset: String| {
            if seen.insert((target.clone(), asset.clone())) {
                pairs.push((target, asset));
            }
        };
        for (target, asset, _) in self.confirm_tag_pairs()? {
            add(target, asset);
        }
        for mode in [None, Some("doubtful")] {
            for item in self.shadow_review_items(mode)?.items {
                add(item.target_id, item.asset_id);
            }
        }
        Ok(pairs)
    }

    /// The queue of pairs that still need Claude's opinion, with their references and keys.
    /// Pairs whose cascade already ended in "leave for the user" for the current references
    /// are not asked again.
    fn claude_build_queue(&self) -> Result<Vec<QueuedPair>> {
        let pairs = self.claude_open_pairs()?;
        if pairs.is_empty() {
            return Ok(Vec::new());
        }
        let target_ids = pairs
            .iter()
            .map(|(target, _)| target.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        // Reference files are checked without the database lock.
        let targets = self
            .character_targets_unlocked(&target_ids)?
            .into_iter()
            .map(|target| (target.id.clone(), target))
            .collect::<BTreeMap<_, _>>();
        let asset_ids = pairs
            .iter()
            .map(|(_, asset)| asset.clone())
            .chain(targets.values().flat_map(|target| {
                target
                    .references
                    .iter()
                    .filter_map(|reference| reference.asset_id.clone())
            }))
            .collect::<BTreeSet<_>>();
        let c = self.connection()?;
        let protected = c
            .prepare(
                "SELECT target_id,asset_id FROM character_references
             WHERE target_id IN (SELECT value FROM json_each(?1)) AND asset_id IS NOT NULL
             UNION
             SELECT target_id,asset_id FROM character_learned_references
             WHERE target_id IN (SELECT value FROM json_each(?1))",
            )?
            .query_map([serde_json::to_string(&target_ids)?], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<BTreeSet<_>, _>>()?;
        let mut target_order = BTreeMap::new();
        for (target, _) in &pairs {
            let next = target_order.len();
            target_order.entry(target.clone()).or_insert(next);
        }
        let assets = {
            let wanted = serde_json::to_string(&asset_ids)?;
            c.prepare(
                "SELECT id,content_hash,relative_path FROM assets
                 WHERE id IN (SELECT value FROM json_each(?1))
                   AND status='normal' AND media_kind='image'",
            )?
            .query_map([wanted], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (row.get::<_, String>(1)?, row.get::<_, String>(2)?),
                ))
            })?
            .collect::<std::result::Result<BTreeMap<_, _>, _>>()?
        };
        let series_names = {
            let series = targets
                .values()
                .filter_map(|target| target.series_classification_id.clone())
                .collect::<BTreeSet<_>>();
            let wanted = serde_json::to_string(&series)?;
            c.prepare(
                "SELECT id,name FROM classification_entries
                 WHERE id IN (SELECT value FROM json_each(?1))",
            )?
            .query_map([wanted], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<BTreeMap<_, _>, _>>()?
        };
        let mut queue = Vec::new();
        for (target_id, asset_id) in pairs {
            if protected.contains(&(target_id.clone(), asset_id.clone())) {
                continue;
            }
            let Some(target) = targets
                .get(&target_id)
                .filter(|target| target.enabled && target.role == "character")
            else {
                continue;
            };
            let Some((asset_hash, relative_path)) = assets.get(&asset_id) else {
                continue;
            };
            let mut references = target
                .references
                .iter()
                .filter(|reference| reference.status == "ready")
                .collect::<Vec<_>>();
            references.sort_by_key(|reference| reference.slot);
            let sent = references
                .into_iter()
                .filter_map(|reference| {
                    let (_, path) = assets.get(reference.asset_id.as_deref()?)?;
                    Some(SentReference {
                        reference: reference.clone(),
                        relative_path: path.clone(),
                    })
                })
                .take(MAX_REFERENCES)
                .collect::<Vec<_>>();
            if sent.is_empty() {
                continue;
            }
            let key = reference_key(sent.iter().map(|r| r.reference.asset_hash.as_str()));
            let haiku = load_opinion(&c, &target_id, asset_hash, &key, HAIKU)?;
            let sonnet = load_opinion(&c, &target_id, asset_hash, &key, SONNET)?;
            if cascade(haiku.as_ref(), sonnet.as_ref()) == Step::Done(Outcome::Leave) {
                continue;
            }
            queue.push(QueuedPair {
                display_name: target.display_name.clone(),
                series_name: target
                    .series_classification_id
                    .as_ref()
                    .and_then(|series| series_names.get(series).cloned()),
                target_id,
                asset_id,
                asset_hash: asset_hash.clone(),
                relative_path: relative_path.clone(),
                reference_key: key,
                references: sent,
            });
        }
        queue.sort_by_key(|pair| target_order[&pair.target_id]);
        Ok(queue)
    }

    /// Reads and encodes one image for the model. Nothing here holds the library connection.
    fn claude_encode(&self, relative_path: &str) -> Option<String> {
        let media = self.open_library_media(relative_path).ok()?;
        let image = decode_oriented_image(media.file).ok()?;
        Some(base64(&jpeg_for_model(image)?))
    }

    /// The pair as it stands now: its image still current and no decision that a person (or
    /// anyone but the native/S36 passes) made. Returns the newest decision sequence, which the
    /// write must still find unchanged.
    fn claude_pair_now(&self, pair: &QueuedPair) -> Result<Option<Option<i64>>> {
        let c = self.connection()?;
        let current: Option<String> = c
            .query_row(
                "SELECT content_hash FROM assets WHERE id=?1 AND status='normal' AND media_kind='image'",
                [&pair.asset_id],
                |row| row.get(0),
            )
            .optional()?;
        if current.as_deref() != Some(pair.asset_hash.as_str()) {
            return Ok(None);
        }
        Ok(open_sequence(&c, &pair.target_id, &pair.asset_id)?)
    }

    /// Writes Claude's decision if the pair is still exactly as judged.
    fn claude_write_decision(
        &self,
        pair: &QueuedPair,
        sequence: Option<i64>,
        outcome: Outcome,
        haiku: &Opinion,
        sonnet: Option<&Opinion>,
    ) -> Result<bool> {
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<String> = tx
            .query_row(
                "SELECT content_hash FROM assets WHERE id=?1 AND status='normal' AND media_kind='image'",
                [&pair.asset_id],
                |row| row.get(0),
            )
            .optional()?;
        if current.as_deref() != Some(pair.asset_hash.as_str()) {
            return Ok(false);
        }
        if open_sequence(&tx, &pair.target_id, &pair.asset_id)? != Some(sequence) {
            return Ok(false);
        }
        let target = match self.read_character_target(&tx, &pair.target_id) {
            Ok(target) => target,
            Err(Error::NotFound) => return Ok(false),
            Err(error) => return Err(error),
        };
        let protected: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_references WHERE target_id=?1 AND asset_id=?2)
                 OR EXISTS(SELECT 1 FROM character_learned_references WHERE target_id=?1 AND asset_id=?2)",
            params![pair.target_id, pair.asset_id],
            |row| row.get(0),
        )?;
        if !target.enabled || target.role != "character" || protected {
            return Ok(false);
        }
        let summary = |opinion: &Opinion| json!({"verdict": opinion.verdict.stored(), "confidence": opinion.confidence});
        let snapshot = json!({
            "scanId": null,
            "prediction": {
                "engine": "claude",
                "haiku": summary(haiku),
                "sonnet": sonnet.map(summary),
                "referenceKey": pair.reference_key,
            },
            "references": pair.references.iter().map(|r| &r.reference).collect::<Vec<_>>(),
        });
        match outcome {
            Outcome::Accept => {
                self.accept_s36_in(&tx, &target, &pair.asset_id, &pair.asset_hash, &snapshot)?
            }
            Outcome::Reject => reject_in(
                self,
                &tx,
                &target,
                &pair.asset_id,
                &pair.asset_hash,
                &snapshot,
            )?,
            Outcome::Leave => return Ok(false),
        }
        tx.commit()?;
        Ok(true)
    }

    fn claude_store_opinion(
        &self,
        pair: &QueuedPair,
        model: &str,
        opinion: &Opinion,
    ) -> Result<()> {
        self.connection()?.execute(
            "INSERT OR REPLACE INTO character_claude_opinions
             (target_id,asset_hash,reference_key,model,verdict,confidence,reason,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                pair.target_id,
                pair.asset_hash,
                pair.reference_key,
                model,
                opinion.verdict.stored(),
                opinion.confidence,
                opinion.reason,
                opinion.input_tokens,
                opinion.output_tokens,
                opinion.cache_write_tokens,
                opinion.cache_read_tokens,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    /// The cascade for one pair: opinions already stored are reused, missing ones asked for
    /// (cap checked before every request), the decision written when the cascade settles it.
    fn claude_process(&self, runner: &Runner<'_>, pair: &QueuedPair) -> Result<Flow> {
        let Some(sequence) = self.claude_pair_now(pair)? else {
            return Ok(Flow::Done(PairResult::Skipped));
        };
        let (mut haiku, mut sonnet) = {
            let c = self.connection()?;
            (
                load_opinion(
                    &c,
                    &pair.target_id,
                    &pair.asset_hash,
                    &pair.reference_key,
                    HAIKU,
                )?,
                load_opinion(
                    &c,
                    &pair.target_id,
                    &pair.asset_hash,
                    &pair.reference_key,
                    SONNET,
                )?,
            )
        };
        // Images are encoded once per pair, only when a request is needed.
        let mut content: Option<Vec<Value>> = None;
        loop {
            let model = match cascade(haiku.as_ref(), sonnet.as_ref()) {
                Step::Done(Outcome::Leave) => return Ok(Flow::Done(PairResult::Left)),
                Step::Done(outcome) => {
                    let Some(haiku) = haiku.as_ref() else {
                        return Ok(Flow::Done(PairResult::Skipped));
                    };
                    let written = self.claude_write_decision(
                        pair,
                        sequence,
                        outcome,
                        haiku,
                        sonnet.as_ref(),
                    )?;
                    return Ok(Flow::Done(match (written, outcome) {
                        (false, _) | (_, Outcome::Leave) => PairResult::Skipped,
                        (true, Outcome::Accept) => PairResult::Accepted,
                        (true, Outcome::Reject) => PairResult::Rejected,
                    }));
                }
                Step::AskHaiku => HAIKU,
                Step::AskSonnet => SONNET,
            };
            if runner.stop.load(Ordering::Acquire) {
                return Ok(Flow::Cancelled);
            }
            let settings = self.claude_settings()?;
            let spent = spend_usd(&*self.connection()?, &month_start(Local::now()))?;
            if spent >= settings.monthly_cap_usd {
                return Ok(Flow::Capped);
            }
            if content.is_none() {
                let candidate = self.claude_encode(&pair.relative_path);
                let references = pair
                    .references
                    .iter()
                    .map(|r| {
                        self.claude_encode(&r.relative_path)
                            .map(|data| (r.reference.asset_hash.clone(), data))
                    })
                    .collect::<Option<Vec<_>>>();
                let (Some(candidate), Some(references)) = (candidate, references) else {
                    return Ok(Flow::Done(PairResult::Skipped));
                };
                content = Some(message_content(
                    &references,
                    &pair.display_name,
                    pair.series_name.as_deref(),
                    &candidate,
                ));
            }
            let content = content.as_deref().unwrap_or_default();
            match runner.ask(model, content) {
                Ok(opinion) => {
                    self.claude_store_opinion(pair, model, &opinion)?;
                    if model == HAIKU {
                        haiku = Some(opinion);
                    } else {
                        sonnet = Some(opinion);
                    }
                }
                Err(CallError::Auth) => return Ok(Flow::Credential),
                Err(CallError::Cancelled) => return Ok(Flow::Cancelled),
                Err(CallError::Transient) => return Ok(Flow::Transient),
                Err(CallError::Invalid) => return Ok(Flow::Done(PairResult::Skipped)),
            }
        }
    }

    /// The idle owner's Claude step: one pair per turn. The caller has established that the PC
    /// is idle and not in saver mode; this returns whether it made progress.
    pub(super) fn advance_character_claude(&self, stop: &AtomicBool) -> bool {
        if !self.claude_wanted() {
            return false;
        }
        if !self.augmentation_idle_allowed(stop).unwrap_or(false) {
            return false;
        }
        let read_key = || {
            super::credential::read_claude_key_os()
                .ok()
                .flatten()
                .map(|credentials| credentials.api_key.clone())
        };
        self.claude_step(stop, http_transport(), &read_key)
    }

    /// Cheap in-memory gate for the idle chain: false while settings and the key said "off".
    fn claude_wanted(&self) -> bool {
        let state = self.claude_state();
        !(state.checked && state.dormant)
    }

    pub(super) fn claude_step(
        &self,
        stop: &AtomicBool,
        transport: &dyn Transport,
        read_key: &dyn Fn() -> Option<String>,
    ) -> bool {
        match self.claude_turn(stop, transport, read_key) {
            Ok(progress) => progress,
            Err(error) => {
                eprintln!("Claude 자동 판정을 계속하지 못했습니다: {error}");
                let mut state = self.claude_state();
                state.error = true;
                state.active = false;
                state.retry_at = Some(Instant::now() + RETRY_LATER);
                false
            }
        }
    }

    fn claude_turn(
        &self,
        stop: &AtomicBool,
        transport: &dyn Transport,
        read_key: &dyn Fn() -> Option<String>,
    ) -> Result<bool> {
        if stop.load(Ordering::Acquire) {
            return Ok(false);
        }
        let checked = self.claude_state().checked;
        if !checked {
            let enabled = self.claude_settings()?.enabled;
            let has_key = read_key().is_some();
            let mut state = self.claude_state();
            state.checked = true;
            state.dormant = !enabled || !has_key;
        }
        if self.claude_state().dormant {
            return Ok(false);
        }
        let now = Local::now();
        // A month that ended frees a run that stopped at the cap.
        {
            let mut state = self.claude_state();
            if state
                .capped_month
                .as_ref()
                .is_some_and(|month| *month != month_label(now))
            {
                state.capped_month = None;
                state.dirty = true;
            }
            if state.capped_month.is_some() {
                return Ok(false);
            }
            // After a failure the run waits for its retry time before looking again.
            if let Some(at) = state.retry_at {
                if Instant::now() < at {
                    return Ok(false);
                }
                state.retry_at = None;
                state.dirty = true;
            }
        }
        let marker = self.review_marker()?;
        let rebuild = {
            let state = self.claude_state();
            state.dirty || state.built_marker.as_deref() != Some(marker.as_str())
        };
        if rebuild {
            let queue = self.claude_build_queue()?;
            let mut state = self.claude_state();
            state.dirty = false;
            state.built_marker = Some(marker);
            state.total = queue.len();
            state.done = 0;
            state.queue = queue.into();
            state.progress_at = Some(Instant::now());
        }
        let Some(pair) = self.claude_state().queue.front().cloned() else {
            return Ok(false);
        };
        let Some(api_key) = read_key() else {
            let mut state = self.claude_state();
            state.dormant = true;
            state.queue.clear();
            return Ok(false);
        };
        self.claude_state().active = true;
        let runner = Runner {
            transport,
            api_key: &api_key,
            stop,
        };
        let flow = self.claude_process(&runner, &pair);
        // The marker after our own write, so only other changes rebuild the queue.
        let marker_after = self.review_marker().ok();
        let mut state = self.claude_state();
        state.active = false;
        let flow = match flow {
            Ok(flow) => flow,
            Err(error) => {
                state.queue.clear();
                return Err(error);
            }
        };
        match flow {
            Flow::Cancelled => return Ok(false),
            Flow::Capped => {
                state.queue.clear();
                state.capped_month = Some(month_label(now));
                state.last_run_at = Some(Utc::now().to_rfc3339());
                return Ok(false);
            }
            Flow::Credential => {
                state.queue.clear();
                state.credential_error = true;
                state.dormant = true;
                return Ok(false);
            }
            Flow::Transient => {
                state.queue.pop_front();
                state.done += 1;
                state.progress_at = Some(Instant::now());
                state.transient_streak += 1;
                state.error = true;
                if state.transient_streak >= MAX_TRANSIENT_STREAK {
                    state.queue.clear();
                    state.retry_at = Some(Instant::now() + RETRY_LATER);
                    return Ok(false);
                }
            }
            Flow::Done(result) => {
                state.queue.pop_front();
                state.done += 1;
                state.progress_at = Some(Instant::now());
                state.transient_streak = 0;
                state.error = false;
                if result != PairResult::Skipped {
                    state.last_run_at = Some(Utc::now().to_rfc3339());
                }
                if matches!(result, PairResult::Accepted | PairResult::Rejected) {
                    if let Some(marker) = marker_after {
                        state.built_marker = Some(marker);
                    }
                }
            }
        }
        Ok(true)
    }
}

/// `Some(newest decision sequence)` when the pair is still open for Claude, `None` when a
/// decision a person made (or Claude's own, or a rejection) already settles it. An automatic
/// acceptance of the native/S36 passes and an automatic `cleared` row leave it open; a person
/// who took the image out of the folder is never overridden.
fn open_sequence(c: &Connection, target_id: &str, asset_id: &str) -> Result<Option<Option<i64>>> {
    let newest: Option<(i64, String, String, String)> = c
        .query_row(
            "SELECT sequence,decision,origin,reference_snapshot FROM character_decisions
             WHERE target_id=?1 AND source_asset_id=?2 ORDER BY sequence DESC LIMIT 1",
            params![target_id, asset_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((sequence, decision, origin, snapshot)) = newest else {
        return Ok(Some(None));
    };
    let open = match (decision.as_str(), origin.as_str()) {
        ("cleared", origin) => origin != "manual",
        ("accepted", "automatic") => {
            serde_json::from_str::<Value>(&snapshot)
                .ok()
                .and_then(|value| value["prediction"]["engine"].as_str().map(str::to_owned))
                .as_deref()
                != Some("claude")
        }
        _ => false,
    };
    Ok(open.then_some(Some(sequence)))
}

#[cfg(test)]
#[path = "character_claude_tests.rs"]
mod tests;
