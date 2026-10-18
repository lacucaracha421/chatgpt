//! Explicit offline experiment; no Library instance, migrations, or production writes.
//! Results and a durable request reservation journal live outside the library. Ambiguous
//! requests remain fully charged against the cap: never retry them automatically.
use super::*;
use rusqlite::OpenFlags;
use serde::{Deserialize, Serialize};
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

type ProbeResult<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const VERSION: u32 = 2;
const HARD_CAP: f64 = 8.0;
const OUTPUT_LIMIT: u32 = 2000;
// The first two of the app's ready, slot-ordered references keep this experiment
// within the requested 2-4 range while reducing cost on five-member prompts.
const PROBE_REFERENCES: usize = 2;
// Reserve the entire model context at the most expensive input rate (5-minute
// cache creation), not an estimated image/token count. Both experiment models fit
// within this one-million-token ceiling. This intentionally stops early near $8.
const INPUT_CEILING: u32 = 1_000_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Picture {
    pub(super) id: String,
    pub(super) hash: String,
    pub(super) path: String,
    pub(super) width: u32,
    pub(super) height: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Member {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) references: Vec<Picture>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Sample {
    pub(super) series: String,
    pub(super) series_name: String,
    pub(super) member_count: usize,
    pub(super) image: Picture,
    pub(super) truth: BTreeSet<String>,
    pub(super) truth_source: String,
    pub(super) candidates: Vec<Member>,
    pub(super) missing_scores: usize,
    /// Target id of the one character already accepted on this image. It is listed among
    /// the candidates for context only: it is never asked about, proposed or written again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) known: Option<String>,
}
#[derive(Serialize, Deserialize)]
pub(super) struct Manifest {
    pub(super) version: u32,
    pub(super) seed: u64,
    pub(super) library: PathBuf,
    pub(super) policy: String,
    pub(super) samples: Vec<Sample>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Present {
    pub(super) label: String,
    pub(super) confidence: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Answer {
    pub(super) present: Vec<Present>,
    pub(super) none: bool,
}
#[derive(Clone, Copy, Default, Debug, Serialize, Deserialize)]
pub(super) struct Usage {
    pub(super) input: u32,
    pub(super) output: u32,
    pub(super) cache_write: u32,
    pub(super) cache_read: u32,
}
impl Usage {
    pub(super) fn cost(self, model: &str) -> f64 {
        cost_usd(
            model,
            self.input,
            self.output,
            self.cache_write,
            self.cache_read,
        )
    }
    pub(super) fn parse(v: &Value) -> ProbeResult<Self> {
        let get = |name: &str, optional: bool| -> ProbeResult<u32> {
            if optional && v.get(name).is_none() {
                return Ok(0);
            }
            Ok(u32::try_from(
                v[name]
                    .as_u64()
                    .ok_or("Missing response usage; reservation retained")?,
            )?)
        };
        Ok(Self {
            input: get("input_tokens", false)?,
            output: get("output_tokens", false)?,
            cache_write: get("cache_creation_input_tokens", true)?,
            cache_read: get("cache_read_input_tokens", true)?,
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Record {
    key: String,
    model: String,
    sample: Sample,
    usage: Usage,
    usd: f64,
    answer: Option<Answer>,
    error: Option<String>,
    request_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Reservation {
    key: String,
    model: String,
    usd: f64,
}

pub(super) fn label(index: usize) -> String {
    ((b'A' + index as u8) as char).to_string()
}
fn bucket(n: usize) -> &'static str {
    if n <= 5 {
        "2-5"
    } else if n <= 15 {
        "6-15"
    } else {
        "16+"
    }
}
fn reserve(model: &str) -> f64 {
    cost_usd(model, 0, OUTPUT_LIMIT, INPUT_CEILING, 0)
}
fn can_spend(spent: f64, reserved: f64, cap: f64) -> bool {
    spent + reserved <= cap.min(HARD_CAP)
}
fn hash_order(seed: u64, key: &str) -> String {
    reference_key([seed.to_string().as_str(), key])
}
fn sample_key(s: &Sample, model: &str) -> ProbeResult<String> {
    Ok(reference_key([serde_json::to_string(&(
        VERSION, s, model,
    ))?
    .as_str()]))
}
fn open_ro(path: &Path) -> ProbeResult<Connection> {
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    c.busy_timeout(Duration::from_secs(5))?;
    c.execute_batch("PRAGMA query_only=ON; BEGIN;")?;
    Ok(c)
}
fn media_path(root: &Path, relative: &str) -> ProbeResult<PathBuf> {
    let p = root.join(relative).canonicalize()?;
    if !p.starts_with(root) {
        return Err("Media path leaves library".into());
    }
    Ok(p)
}
fn picture(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Picture> {
    Ok(Picture {
        id: row.get(offset)?,
        hash: row.get(offset + 1)?,
        path: row.get(offset + 2)?,
        width: row.get(offset + 3)?,
        height: row.get(offset + 4)?,
    })
}

/// Balance member-count and none/single/multiple strata, then round-robin series.
fn stratify(pool: Vec<Sample>, count: usize, seed: u64) -> Vec<Sample> {
    let mut groups = BTreeMap::<(String, usize), BTreeMap<String, Vec<Sample>>>::new();
    for s in pool {
        groups
            .entry((bucket(s.member_count).into(), s.truth.len().min(2)))
            .or_default()
            .entry(s.series.clone())
            .or_default()
            .push(s);
    }
    let mut queues = Vec::<VecDeque<Sample>>::new();
    for series in groups.values_mut() {
        for images in series.values_mut() {
            images.sort_by_key(|s| hash_order(seed, &s.image.id));
        }
        let mut queue = VecDeque::new();
        while series.values().any(|v| !v.is_empty()) {
            for images in series.values_mut() {
                if let Some(s) = images.pop() {
                    queue.push_back(s);
                }
            }
        }
        queues.push(queue);
    }
    let mut out = Vec::new();
    while out.len() < count && queues.iter().any(|q| !q.is_empty()) {
        for queue in &mut queues {
            if out.len() == count {
                break;
            }
            if let Some(s) = queue.pop_front() {
                out.push(s);
            }
        }
    }
    // Identical candidate prefixes are adjacent, labels are stable target-id order.
    out.sort_by_key(|s| {
        (
            s.series.clone(),
            s.candidates
                .iter()
                .map(|m| m.id.clone())
                .collect::<Vec<_>>(),
            s.image.id.clone(),
        )
    });
    out
}

fn build_sample(root: &Path, count: usize, seed: u64) -> ProbeResult<Manifest> {
    let mut manifest = build_pool(root, false)?;
    manifest.seed = seed;
    manifest.samples = stratify(manifest.samples, count, seed);
    Ok(manifest)
}

// App and experiment share reference selection and top-five narrowing. The app cohort
// deliberately excludes every prior judgment; the experiment uses manual truth instead.
pub(super) fn build_pool(root: &Path, unclassified: bool) -> ProbeResult<Manifest> {
    let db = open_ro(&root.join("library.sqlite"))?;
    let cache_path = root.join(".cache/characters/s36_shadow.sqlite");
    let cache = if cache_path.exists() {
        open_ro(&cache_path)?
    } else {
        let c = Connection::open_in_memory()?;
        c.execute_batch("CREATE TABLE scores(asset_id TEXT,content_hash TEXT,target_id TEXT,knn3 REAL,policy_version TEXT,scored_at TEXT,verdict TEXT);")?;
        c
    };
    let policy: String = cache.query_row("SELECT policy_version FROM scores GROUP BY policy_version ORDER BY MAX(scored_at) DESC,policy_version DESC LIMIT 1", [], |r| r.get(0)).optional()?.unwrap_or_default();
    let scores = cache.prepare("SELECT asset_id,content_hash,target_id,knn3 FROM scores WHERE policy_version=?1 AND knn3 IS NOT NULL")?
        .query_map([&policy], |r| Ok(((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?), r.get::<_,f64>(3)?)))?
        .collect::<rusqlite::Result<BTreeMap<_,_>>>()?;
    let targets = db.prepare("SELECT t.id,t.display_name,t.series_classification_id,c.name,t.role,t.extras_group_id FROM character_targets t JOIN classification_entries c ON c.id=t.series_classification_id WHERE t.enabled=1 ORDER BY t.id")?
        .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,Option<String>>(5)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut members = BTreeMap::<String, Vec<Member>>::new();
    let mut names = BTreeMap::new();
    for (id, name, series, series_name, role, _) in &targets {
        names.insert(series.clone(), series_name.clone());
        if role != "character" {
            continue;
        }
        // Same explicit reference slots and order as claude_build_queue; never learned
        // examples. Series membership, content hash, file presence and status checked.
        let refs = db.prepare("WITH RECURSIVE scope(id) AS (SELECT ?2 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id)
            SELECT a.id,a.content_hash,a.relative_path,a.width,a.height FROM character_references r JOIN assets a ON a.id=r.asset_id
            WHERE r.target_id=?1 AND a.status='normal' AND a.media_kind='image' AND a.content_hash=r.asset_hash
            AND EXISTS(SELECT 1 FROM asset_classifications ac JOIN scope s ON ac.classification_id=s.id WHERE ac.asset_id=a.id) ORDER BY r.slot")?
            .query_map(params![id,series], |r| picture(r,0))?.collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter().filter(|p| media_path(root,&p.path).is_ok()).take(PROBE_REFERENCES.min(MAX_REFERENCES)).collect();
        members.entry(series.clone()).or_default().push(Member {
            id: id.clone(),
            name: name.clone(),
            references: refs,
        });
    }
    // All decisions are read first, then the newest per pair is selected. A historical
    // manual acceptance that was later cleared/automated is never resurrected.
    let decisions = db.prepare("SELECT d.target_id,d.source_asset_id,d.asset_hash,d.decision,d.origin FROM character_decisions d
        WHERE NOT EXISTS(SELECT 1 FROM character_decisions newer WHERE newer.target_id=d.target_id AND newer.source_asset_id=d.source_asset_id AND newer.sequence>d.sequence)")?
        .query_map([], |r| Ok(((r.get::<_,String>(0)?,r.get::<_,String>(1)?), (r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))))?
        .collect::<rusqlite::Result<BTreeMap<_,_>>>()?;
    let mut by_asset = BTreeMap::<String, Vec<(String, String, String)>>::new();
    for ((target, asset), (hash, decision, _)) in &decisions {
        by_asset.entry(asset.clone()).or_default().push((
            target.clone(),
            hash.clone(),
            decision.clone(),
        ));
    }
    let rows = db.prepare("WITH RECURSIVE scope(series,id) AS (SELECT classification_id,classification_id FROM character_series UNION SELECT s.series,c.id FROM scope s JOIN classification_entries c ON c.parent_id=s.id)
        SELECT DISTINCT s.series,a.id,a.content_hash,a.relative_path,a.width,a.height FROM scope s JOIN asset_classifications ac ON ac.classification_id=s.id JOIN assets a ON a.id=ac.asset_id
        WHERE a.status='normal' AND a.media_kind='image' AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.asset_id=a.id)")?
        .query_map([], |r| Ok((r.get::<_,String>(0)?,picture(r,1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut pool = Vec::new();
    let excluded_app = if unclassified {
        // Decisions are judged per image below. An item that has not been sent yet (and has no
        // request) belongs to a plan that is about to be replaced, so it stays available.
        // Images waiting in the 확인 list are left out: Claude's own pending recommendations, tagger
        // pending pairs and S36 shadow candidates below. Saved B36 scan recommendations are not
        // part of that list (see character_review_feed), so they do not block an image.
        let mut ids = db.prepare("SELECT ac.asset_id FROM asset_classifications ac JOIN character_targets t ON t.linked_classification_id=ac.classification_id UNION SELECT asset_id FROM character_tagger_pending UNION SELECT asset_id FROM character_member_items WHERE mode='ongoing' OR state<>'pending' OR EXISTS(SELECT 1 FROM character_member_requests r WHERE r.item_id=character_member_items.id) UNION SELECT asset_id FROM character_member_pending")?
            .query_map([], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<BTreeSet<_>>>()?;
        ids.extend(cache.prepare("SELECT asset_id FROM scores WHERE policy_version=?1 AND verdict IN ('automatic','recommended')")?.query_map([&policy], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
        ids
    } else {
        BTreeSet::new()
    };
    let mut excluded = BTreeMap::<&str, usize>::new();
    for (series, image) in rows {
        if excluded_app.contains(&image.id) {
            continue;
        }
        let Some(all) = members.get(&series).filter(|m| m.len() >= 2) else {
            continue;
        };
        let decision = |id: &str| {
            decisions
                .get(&(id.to_owned(), image.id.clone()))
                .filter(|d| d.0 == image.hash)
        };
        // The app cohort is images without any decision, or with exactly one accepted
        // character of this series (any origin) whose other members have no decision.
        let mut known = None::<String>;
        let mut decided = BTreeSet::<&str>::new();
        if unclassified {
            if let Some(rows) = by_asset.get(&image.id) {
                let accepted = rows
                    .iter()
                    .filter(|r| r.1 == image.hash && r.2 == "accepted")
                    .collect::<Vec<_>>();
                match accepted.as_slice() {
                    [one] if all.iter().any(|m| m.id == one.0) => known = Some(one.0.clone()),
                    _ => continue,
                }
                decided = rows.iter().map(|r| r.0.as_str()).collect();
            }
        }
        // A current automatic/unknown judgment is never part of this manual-only
        // cohort, even if another member of the same image was manually accepted.
        if !unclassified
            && all
                .iter()
                .any(|m| decision(&m.id).is_some_and(|d| d.2 != "manual" && d.1 != "cleared"))
        {
            *excluded.entry("automatic/unknown judgment").or_default() += 1;
            continue;
        }
        let truth: BTreeSet<_> = if unclassified {
            known.iter().cloned().collect()
        } else {
            all.iter()
                .filter(|m| decision(&m.id).is_some_and(|d| d.2 == "manual" && d.1 == "accepted"))
                .map(|m| m.id.clone())
                .collect()
        };
        // Group 기타 says none in that group only; only the series-wide bucket is none.
        let extras = !unclassified
            && targets.iter().any(|(id, _, s, _, role, group)| {
                s == &series
                    && role == "extras"
                    && group.is_none()
                    && decision(id).is_some_and(|d| d.2 == "manual" && d.1 == "accepted")
            });
        let rejected = all
            .iter()
            .all(|m| decision(&m.id).is_some_and(|d| d.2 == "manual" && d.1 == "rejected"));
        if !unclassified && truth.is_empty() && !extras && !rejected {
            continue;
        }
        if !truth.is_empty() && extras {
            *excluded.entry("conflicting manual truth").or_default() += 1;
            continue;
        }
        // Candidates to ask about: members without any decision on this image. The known
        // member is added afterwards so the five-member narrowing never spends a slot on it.
        let mut ranked = all
            .iter()
            .filter(|m| known.as_deref() != Some(m.id.as_str()) && !decided.contains(m.id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        let missing_scores = all
            .iter()
            .filter(|m| !scores.contains_key(&(image.id.clone(), image.hash.clone(), m.id.clone())))
            .count();
        if all.len() > 5 {
            ranked.sort_by(|a, b| {
                let score = |m: &Member| {
                    scores
                        .get(&(image.id.clone(), image.hash.clone(), m.id.clone()))
                        .copied()
                        .filter(|v| v.is_finite())
                        .unwrap_or(f64::INFINITY)
                };
                score(a).total_cmp(&score(b)).then_with(|| a.id.cmp(&b.id))
            });
            // Missing scores are not invented; do not fill an absent top five by id.
            ranked.retain(|m| {
                scores
                    .get(&(image.id.clone(), image.hash.clone(), m.id.clone()))
                    .is_some_and(|v| v.is_finite())
            });
            if ranked.len() < 5 {
                *excluded.entry("fewer than five cached scores").or_default() += 1;
                continue;
            }
            ranked.truncate(5);
        }
        if ranked.is_empty() {
            *excluded.entry("no undecided candidate").or_default() += 1;
            continue;
        }
        if ranked.iter().any(|m| m.references.len() < 2) {
            *excluded
                .entry("candidate has fewer than two references")
                .or_default() += 1;
            continue;
        }
        if let Some(member) = all.iter().find(|m| known.as_deref() == Some(m.id.as_str())) {
            ranked.push(member.clone());
        }
        ranked.sort_by(|a, b| a.id.cmp(&b.id));
        if media_path(root, &image.path).is_err() {
            *excluded.entry("missing image").or_default() += 1;
            continue;
        }
        pool.push(Sample {
            series: series.clone(),
            series_name: names[&series].clone(),
            member_count: all.len(),
            image,
            truth,
            truth_source: if unclassified {
                if known.is_some() {
                    "one known member"
                } else {
                    "unclassified"
                }
            } else if extras {
                "series extras"
            } else if rejected {
                "all members manually rejected"
            } else {
                "manual accepted set (unlabelled members are not proven absent)"
            }
            .into(),
            candidates: ranked,
            missing_scores,
            known,
        });
    }
    println!("Eligible pool: {}; exclusions: {:?}", pool.len(), excluded);
    Ok(Manifest {
        version: VERSION,
        seed: 0,
        library: root.to_owned(),
        policy,
        samples: pool,
    })
}

fn print_plan(m: &Manifest) {
    println!(
        "Seed: {}; S36 policy: {}; sample: {}",
        m.seed,
        m.policy,
        m.samples.len()
    );
    let mut groups = BTreeMap::<String, Vec<&Sample>>::new();
    for s in &m.samples {
        groups
            .entry(format!("{} | {}", bucket(s.member_count), s.series_name))
            .or_default()
            .push(s);
    }
    for name in ["2-5", "6-15", "16+"] {
        let rows = m
            .samples
            .iter()
            .filter(|s| bucket(s.member_count) == name)
            .collect::<Vec<_>>();
        let positives = rows.iter().filter(|s| !s.truth.is_empty()).count();
        let multi = rows.iter().filter(|s| s.truth.len() > 1).count();
        let total = rows.iter().map(|s| s.truth.len()).sum::<usize>();
        let inside = rows
            .iter()
            .map(|s| {
                s.truth
                    .iter()
                    .filter(|id| s.candidates.iter().any(|c| &c.id == *id))
                    .count()
            })
            .sum::<usize>();
        println!("Bucket {name}: n={} positive={positives} multi={multi} none={} narrowing={inside}/{total}",rows.len(),rows.len()-positives);
    }
    let sources = m
        .samples
        .iter()
        .fold(BTreeMap::<&str, usize>::new(), |mut counts, s| {
            *counts.entry(&s.truth_source).or_default() += 1;
            counts
        });
    println!("Truth sources: {sources:?}");
    for (name, rows) in groups {
        let positives = rows.iter().filter(|s| !s.truth.is_empty()).count();
        let multi = rows.iter().filter(|s| s.truth.len() > 1).count();
        let total: usize = rows.iter().map(|s| s.truth.len()).sum();
        let inside: usize = rows
            .iter()
            .map(|s| {
                s.truth
                    .iter()
                    .filter(|id| s.candidates.iter().any(|c| &c.id == *id))
                    .count()
            })
            .sum();
        let all = rows
            .iter()
            .filter(|s| {
                !s.truth.is_empty()
                    && s.truth
                        .iter()
                        .all(|id| s.candidates.iter().any(|c| &c.id == id))
            })
            .count();
        println!("{name}: n={} positive={positives} multi={multi} none={} narrowing={inside}/{total} all-true={all}/{positives}",rows.len(),rows.len()-positives);
    }
    println!("Positive truth is the recorded manual accepted set, not an exhaustive reannotation. S36 may have learned from these old images; this is retrospective, not a held-out generalization test.");
    println!("Offline estimates use resized image area/750, text bytes/3, 300 output tokens; cache benefit assumes adjacent identical prefixes hit. Estimates are not billing limits.");
    for model in [HAIKU, SONNET] {
        let mut uncached = 0.0;
        let mut cached = 0.0;
        let mut total_input = 0u32;
        let mut previous = String::new();
        for s in &m.samples {
            let image_tokens = |p: &Picture| {
                let scale = (MAX_IMAGE_EDGE as f64 / p.width.max(p.height) as f64).min(1.0);
                ((p.width as f64 * p.height as f64 * scale * scale) / 750.0).ceil() as u32
            };
            let reference_tokens = s
                .candidates
                .iter()
                .map(|c| {
                    c.references.iter().map(image_tokens).sum::<u32>()
                        + c.name.len() as u32 / 3
                        + 40
                })
                .sum::<u32>();
            let input = image_tokens(&s.image) + 500;
            let prefix = reference_key(
                s.candidates
                    .iter()
                    .flat_map(|c| c.references.iter().map(|r| r.hash.as_str())),
            );
            uncached += cost_usd(model, input + reference_tokens, 300, 0, 0);
            cached += if prefix == previous {
                cost_usd(model, input, 300, 0, reference_tokens)
            } else {
                cost_usd(model, input, 300, reference_tokens, 0)
            };
            total_input += input + reference_tokens;
            previous = prefix;
        }
        println!("{model}: estimated input={total_input} output={} USD no-cache={uncached:.4} grouped-cache={cached:.4}; per-request hard reservation=${:.4}",m.samples.len()*300,reserve(model));
    }
    println!("The $8 cap takes priority over sample completion. Full-context reservations can stop the run early, below $8; report prints completed-pair coverage. Do not split or reset journals to bypass the cap.");
}

fn encode(root: &Path, p: &Picture) -> ProbeResult<String> {
    let path = media_path(root, &p.path)?;
    let bytes = fs::read(&path)?;
    let hash = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if hash != p.hash {
        return Err("Image content changed since sample; create a new experiment".into());
    }
    let image = decode_oriented_image(File::open(path)?)?;
    Ok(base64(&jpeg_for_model(image).ok_or("Cannot encode image")?))
}
pub(super) fn body(root: &Path, s: &Sample, model: &str) -> ProbeResult<Value> {
    request(s, model, &|p| encode(root, p))
}
pub(super) fn request(
    s: &Sample,
    model: &str,
    encode_picture: &dyn Fn(&Picture) -> ProbeResult<String>,
) -> ProbeResult<Value> {
    let mut content=vec![text_block(&format!("Registered candidates for series {}. Labels identify individuals, not appearance similarity.",s.series_name))];
    for (i, c) in s.candidates.iter().enumerate() {
        content.push(text_block(&format!(
            "Candidate {}: {}. Reference images:",
            label(i),
            c.name
        )));
        for r in &c.references {
            content.push(image_block(&encode_picture(r)?));
        }
    }
    content.last_mut().ok_or("No reference block")?["cache_control"] = json!({"type":"ephemeral"});
    content.push(text_block("Image to identify:"));
    content.push(image_block(&encode_picture(&s.image)?));
    let known = s
        .known
        .as_deref()
        .and_then(|id| s.candidates.iter().position(|c| c.id == id));
    content.push(text_block(&match known {
        Some(index) => format!("Candidate {} is already known to be present in this image; never report it. Which of the other listed registered individuals also appear in this image? Return every additionally present label with confidence 0..1, or an empty present array and none=true. Several or no further candidates can be present. Judge identity, allow costume/hairstyle changes. Do not force a match. none must equal present.is_empty().", label(index)),
        None => "Which listed registered individuals appear in this image? Return every present label with confidence 0..1, or an empty present array and none=true. Several or no candidates can be present. Judge identity, allow costume/hairstyle changes. Do not force a match. none must equal present.is_empty().".to_owned(),
    }));
    let mut request = request_body(model, &content);
    request["max_tokens"] = json!(OUTPUT_LIMIT);
    request["output_config"]["format"]["schema"] = json!({"type":"object","properties":{
        "present":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string","enum":(0..s.candidates.len()).filter(|i| Some(*i)!=known).map(label).collect::<Vec<_>>()},"confidence":{"type":"number"}},"required":["label","confidence"],"additionalProperties":false}},
        "none":{"type":"boolean"}},"required":["present","none"],"additionalProperties":false});
    Ok(request)
}
pub(super) fn parse_answer(v: &Value, s: &Sample) -> ProbeResult<Answer> {
    if v["stop_reason"] != "end_turn" {
        return Err("Response refused, truncated or incomplete".into());
    }
    let text = response_text(v).ok_or("No answer text")?;
    let a: Answer = serde_json::from_str(text)?;
    let mut seen = BTreeSet::new();
    for p in &a.present {
        if !p.confidence.is_finite()
            || !(0.0..=1.0).contains(&p.confidence)
            || !(0..s.candidates.len()).any(|i| {
                label(i) == p.label && s.known.as_deref() != Some(s.candidates[i].id.as_str())
            })
            || !seen.insert(&p.label)
        {
            return Err("Invalid label/confidence or repeated label".into());
        }
    }
    if a.none != a.present.is_empty() {
        return Err("Inconsistent none answer".into());
    }
    Ok(a)
}
fn read_lines<T: serde::de::DeserializeOwned>(path: &Path) -> ProbeResult<Vec<T>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path)?;
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        return Err(format!(
            "Incomplete journal {}; preserve it and reconcile before resuming",
            path.display()
        )
        .into());
    }
    BufReader::new(bytes.as_slice())
        .lines()
        .map(|line| Ok(serde_json::from_str(&line?)?))
        .collect()
}
fn append<T: Serialize>(file: &mut File, value: &T) -> ProbeResult<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}
fn accounted(records: &[Record], reservations: &[Reservation]) -> ProbeResult<f64> {
    let mut finished = BTreeSet::new();
    let mut total = 0.0;
    for r in records {
        if !finished.insert(&r.key) {
            return Err("Duplicate result key".into());
        }
        let usd = r.usage.cost(&r.model);
        if !r.usd.is_finite() || (r.usd - usd).abs() > 1e-9 {
            return Err("Result cost disagrees with recorded usage".into());
        }
        total += usd;
    }
    let mut reserved = BTreeSet::new();
    for r in reservations {
        if !reserved.insert(&r.key) {
            return Err("Duplicate reservation key".into());
        }
        if !r.usd.is_finite() || r.usd != reserve(&r.model) {
            return Err("Invalid reservation".into());
        }
        if !finished.contains(&r.key) {
            total += r.usd;
        }
    }
    Ok(total)
}
struct RunLock(PathBuf);
impl Drop for RunLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn run_requests(m: &Manifest, output: &Path, cap: f64) -> ProbeResult<()> {
    let lock_path = output.with_extension("lock");
    let mut lock=OpenOptions::new().write(true).create_new(true).open(&lock_path).map_err(|_|"Experiment is locked; after a crash verify process ownership before removing its .lock file")?;
    let _guard = RunLock(lock_path);
    writeln!(lock, "pid={}", std::process::id())?;
    lock.sync_all()?;
    let ledger_path = output.with_extension("budget.jsonl");
    let mut records: Vec<Record> = read_lines(output)?;
    let mut reservations: Vec<Reservation> = read_lines(&ledger_path)?;
    let mut spent = accounted(&records, &reservations)?;
    let finished: BTreeSet<_> = records.iter().map(|r| r.key.clone()).collect();
    let reserved: BTreeSet<_> = reservations.iter().map(|r| r.key.clone()).collect();
    if reserved.iter().any(|key| !finished.contains(key)) {
        return Err(format!("Unresolved request reservation; ${spent:.4} accounted. Reconcile provider usage before any retry. Journal: {}",ledger_path.display()).into());
    }
    let credentials = super::super::credential::read_claude_key_os()?
        .ok_or("No Claude key in the app credential store")?;
    let mut results = OpenOptions::new().create(true).append(true).open(output)?;
    let mut ledger = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&ledger_path)?;
    // Complete each image's comparison before moving on. Alternating models still
    // reuses each model's preceding identical prefix within the five-minute TTL.
    for s in &m.samples {
        let remaining = [HAIKU, SONNET]
            .into_iter()
            .filter_map(|model| match sample_key(s, model) {
                Ok(key) if !finished.contains(&key) => Some(Ok(reserve(model))),
                Ok(_) => None,
                Err(e) => Some(Err(e)),
            })
            .collect::<ProbeResult<Vec<_>>>()?
            .iter()
            .sum::<f64>();
        if !can_spend(spent, remaining, cap) {
            println!("Stopped before image {}: actual=${spent:.6}, remaining pair worst-case=${remaining:.4}, cap=${cap:.2}",s.image.id);
            return Ok(());
        }
        for model in [HAIKU, SONNET] {
            let key = sample_key(s, model)?;
            if finished.contains(&key) {
                continue;
            }
            if !can_spend(spent, reserve(model), cap) {
                println!("Stopped before {model} {}: actual/accounted=${spent:.6}, next worst-case=${:.4}, cap=${cap:.2}",s.image.id,reserve(model));
                return Ok(());
            }
            let request_body = body(&m.library, s, model)?;
            // Count input using the provider's tokenizer before a billed request.
            // Reserve the full context even when this count is much smaller. Include
            // a schema/format overhead allowance; no API call can expand the input.
            let count_request =
                serde_json::to_vec(&json!({"model":model,"messages":request_body["messages"]}))?;
            let counted = http_transport()
                .post_url(
                    &credentials.api_key,
                    &count_request,
                    "https://api.anthropic.com/v1/messages/count_tokens",
                )
                .map_err(|_| "Token preflight failed; no Messages request sent")?;
            let token_count: Value = serde_json::from_str(&counted.body)?;
            if counted.status != 200
                || !token_count["input_tokens"]
                    .as_u64()
                    .is_some_and(|n| n + 8192 <= u64::from(INPUT_CEILING))
            {
                return Err(
                    "Token preflight failed or input exceeds the full-context reservation".into(),
                );
            }
            let request = serde_json::to_vec(&request_body)?;
            let reservation = Reservation {
                key: key.clone(),
                model: model.into(),
                usd: reserve(model),
            };
            append(&mut ledger, &reservation)?;
            reservations.push(reservation);
            // No retry: timeouts can still be billed. The durable reservation survives.
            let reply = http_transport()
                .post(&credentials.api_key, &request)
                .map_err(|_| "Transport failure; full reservation retained, run stopped")?;
            let v: Value = serde_json::from_str(&reply.body)
                .map_err(|_| "Invalid API envelope; full reservation retained")?;
            let usage = Usage::parse(&v["usage"])?;
            let usd = usage.cost(model);
            let answer = if reply.status == 200 {
                parse_answer(&v, s)
            } else {
                Err(format!("HTTP {}", reply.status).into())
            };
            let (answer, error) = match answer {
                Ok(a) => (Some(a), None),
                Err(e) => (None, Some(e.to_string())),
            };
            let record = Record {
                key,
                model: model.into(),
                sample: s.clone(),
                usage,
                usd,
                answer,
                error,
                request_id: v["id"].as_str().map(str::to_owned),
            };
            append(&mut results, &record)?;
            println!(
                "{model} {} ${usd:.6} cache-write={} cache-read={} {}",
                s.image.id,
                usage.cache_write,
                usage.cache_read,
                if record.answer.is_some() {
                    "ok"
                } else {
                    "invalid"
                }
            );
            records.push(record);
            spent = accounted(&records, &reservations)?;
            if usd > reserve(model) {
                return Err("Provider usage exceeded full-context reservation; stop and review model pricing/context limits".into());
            }
        }
    }
    println!("Completed; actual spend=${spent:.6}");
    Ok(())
}

#[derive(Default)]
struct Metrics {
    n: usize,
    valid: usize,
    tp: usize,
    fp: usize,
    fn_: usize,
    exact: usize,
    truth_none: usize,
    predicted_none: usize,
    correct_none: usize,
    usd: f64,
}
impl Metrics {
    fn add(&mut self, s: &Sample, pred: Option<BTreeSet<String>>, usd: f64) {
        self.n += 1;
        self.usd += usd;
        if s.truth.is_empty() {
            self.truth_none += 1;
        }
        let Some(pred) = pred else {
            self.fn_ += s.truth.len();
            return;
        };
        self.valid += 1;
        self.tp += pred.intersection(&s.truth).count();
        self.fp += pred.difference(&s.truth).count();
        self.fn_ += s.truth.difference(&pred).count();
        if pred == s.truth {
            self.exact += 1;
        }
        if pred.is_empty() {
            self.predicted_none += 1;
            if s.truth.is_empty() {
                self.correct_none += 1;
            }
        }
    }
    fn print(&self, name: &str) {
        let ratio = |a: usize, b: usize| {
            if b == 0 {
                "n/a".into()
            } else {
                format!("{:.4}", a as f64 / b as f64)
            }
        };
        println!("{name}: n={} valid={} precision={} recall={} exact={} none P={} R={} (truth={} predicted={} correct={}) actual=${:.6} $/image={:.6} projection/2900=${:.2}",self.n,self.valid,ratio(self.tp,self.tp+self.fp),ratio(self.tp,self.tp+self.fn_),ratio(self.exact,self.n),ratio(self.correct_none,self.predicted_none),ratio(self.correct_none,self.truth_none),self.truth_none,self.predicted_none,self.correct_none,self.usd,self.usd/self.n.max(1) as f64,self.usd/self.n.max(1) as f64*2900.0);
    }
}
fn prediction(r: &Record) -> Option<BTreeSet<String>> {
    r.answer.as_ref().map(|a| {
        a.present
            .iter()
            .filter_map(|p| {
                r.sample
                    .candidates
                    .iter()
                    .enumerate()
                    .find(|(i, _)| label(*i) == p.label)
                    .map(|(_, c)| c.id.clone())
            })
            .collect()
    })
}
fn report(path: &Path) -> ProbeResult<()> {
    let records: Vec<Record> = read_lines(path)?;
    if records.is_empty() {
        return Err("No results".into());
    }
    let reservations: Vec<Reservation> = read_lines(&path.with_extension("budget.jsonl"))?;
    println!(
        "Budget accounted (actual + unresolved reservations): ${:.6}",
        accounted(&records, &reservations)?
    );
    let mut metrics = BTreeMap::<String, Metrics>::new();
    let mut paired = BTreeMap::<String, BTreeMap<String, &Record>>::new();
    for r in &records {
        for scope in ["all".to_string(), bucket(r.sample.member_count).to_string()] {
            metrics
                .entry(format!("{} | {scope}", r.model))
                .or_default()
                .add(&r.sample, prediction(r), r.usd);
        }
        paired
            .entry(sample_key(&r.sample, "pair")?)
            .or_default()
            .insert(r.model.clone(), r);
    }
    for (name, m) in metrics {
        m.print(&name);
    }
    for model in [HAIKU, SONNET] {
        let mut usage = Usage::default();
        let mut n = 0;
        for r in records.iter().filter(|r| r.model == model) {
            n += 1;
            usage.input += r.usage.input;
            usage.output += r.usage.output;
            usage.cache_read += r.usage.cache_read;
            usage.cache_write += r.usage.cache_write;
        }
        println!("{model}: billed responses={n} usage={usage:?}");
    }
    let complete = paired
        .values()
        .filter(|p| p.contains_key(HAIKU) && p.contains_key(SONNET))
        .count();
    println!("Paired comparison: {complete}/{} images. Cascade uses only complete pairs; accepts every Haiku present label with its reported confidence (no threshold), otherwise Sonnet. Also shows threshold 0.90. Cost is simulated cascade usage, not the experiment's two-model bill.",paired.len());
    for threshold in [0.0, 0.9] {
        let mut groups = BTreeMap::<String, Metrics>::new();
        let mut fallback = 0;
        let mut confidences = Vec::new();
        for pair in paired.values() {
            let (Some(h), Some(s)) = (pair.get(HAIKU), pair.get(SONNET)) else {
                continue;
            };
            let accepted = h
                .answer
                .as_ref()
                .is_some_and(|a| !a.none && a.present.iter().all(|p| p.confidence >= threshold));
            let chosen = if accepted {
                *h
            } else {
                fallback += 1;
                *s
            };
            if accepted {
                confidences.extend(
                    h.answer
                        .as_ref()
                        .unwrap()
                        .present
                        .iter()
                        .map(|p| p.confidence),
                );
            }
            for scope in ["all".to_string(), bucket(h.sample.member_count).to_string()] {
                groups.entry(scope).or_default().add(
                    &h.sample,
                    prediction(chosen),
                    h.usd + if accepted { 0.0 } else { s.usd },
                );
            }
        }
        let confidence_mean = confidences.iter().sum::<f64>() / confidences.len().max(1) as f64;
        let confidence_min = confidences.iter().copied().reduce(f64::min);
        println!("Cascade threshold={threshold:.2}: Sonnet fallbacks={fallback}, accepted Haiku labels={}, mean confidence={confidence_mean:.4}, minimum={confidence_min:?}",confidences.len());
        for (scope, m) in groups {
            m.print(&format!("cascade {threshold:.2} | {scope}"));
        }
    }
    println!("Projection is an unweighted sample mean, not a backlog prevalence estimate. Cascade costs reuse measured tokens; skipping requests can change cache hits and the real cascade bill. Manual positive sets can be incomplete; S36 scores may include learned examples from these images. Invalid/refused answers count as non-exact; none is scored separately.");
    Ok(())
}

/// CLI entry point for the standalone bin; never called by the application.
pub fn run_cli() -> ProbeResult<()> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || args.iter().any(|a| a == "--help") {
        println!("char_member_probe (--plan|--run --max-usd N|--report) --library PATH --output PATH [--sample-size 240] [--seed 36]\nOutputs: PATH JSONL results; adjacent .sample.json frozen sample, .budget.jsonl durable reservations and .lock single-run guard. Keep these together. Never delete/reset budget journals to retry ambiguous requests. Output must be outside the library. --report needs only --output. --plan never reads credentials or uses the network. Hard experiment cap: $8 (separate from the authorized $50 slice budget).");
        return Ok(());
    }
    let mut mode = None;
    let mut library = None;
    let mut output = None;
    let mut count = 240usize;
    let mut seed = 36u64;
    let mut cap = None;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if ["--plan", "--run", "--report"].contains(&arg.as_str()) {
            if mode.replace(arg.clone()).is_some() {
                return Err("Choose one mode".into());
            }
        } else {
            i += 1;
            let value = args.get(i).ok_or("Missing option value")?;
            match arg.as_str() {
                "--library" => library = Some(PathBuf::from(value)),
                "--output" => output = Some(PathBuf::from(value)),
                "--sample-size" => count = value.parse()?,
                "--seed" => seed = value.parse()?,
                "--max-usd" => cap = Some(value.parse::<f64>()?),
                _ => return Err(format!("Unknown argument {arg}").into()),
            }
        }
        i += 1;
    }
    let mode = mode.ok_or("Choose --plan, --run or --report")?;
    let output = output.ok_or("--output is required")?;
    if mode == "--report" {
        return report(&output);
    }
    if count == 0 || count > 10_000 {
        return Err("Sample size must be 1..10000".into());
    }
    if mode == "--run" && !cap.is_some_and(|n| n.is_finite() && n > 0.0 && n <= HARD_CAP) {
        return Err("--run requires --max-usd in (0,8]".into());
    }
    let root = library.ok_or("--library is required")?.canonicalize()?;
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .canonicalize()?;
    let output = parent.join(output.file_name().ok_or("Output needs a file name")?);
    if parent.starts_with(&root) || output.canonicalize().is_ok_and(|p| p.starts_with(&root)) {
        return Err("Output must be outside the library".into());
    }
    let manifest_path = output.with_extension("sample.json");
    for path in [
        &output,
        &manifest_path,
        &output.with_extension("budget.jsonl"),
        &output.with_extension("lock"),
    ] {
        if path.canonicalize().is_ok_and(|p| p.starts_with(&root)) {
            return Err("Experiment files must not resolve inside the library".into());
        }
    }
    let manifest: Manifest = if manifest_path.exists() {
        let m: Manifest = serde_json::from_slice(&fs::read(&manifest_path)?)?;
        if m.version != VERSION || m.library != root || m.seed != seed {
            return Err(
                "Existing sample has different version/library/seed; use its original options"
                    .into(),
            );
        }
        m
    } else {
        if output.exists() || output.with_extension("budget.jsonl").exists() {
            return Err(
                "Results/journal exist without their sample; restore the sample before continuing"
                    .into(),
            );
        }
        let m = build_sample(&root, count, seed)?;
        if m.samples.is_empty() {
            return Err("No eligible manually decided images".into());
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&manifest_path)?;
        serde_json::to_writer_pretty(&mut file, &m)?;
        file.sync_all()?;
        m
    };
    print_plan(&manifest);
    println!("Frozen sample: {}", manifest_path.display());
    if mode == "--run" {
        run_requests(&manifest, &output, cap.unwrap())?;
    }
    Ok(())
}

#[cfg(test)]
mod member_probe_tests {
    use super::*;
    fn s(id: &str, n: usize, positive: bool) -> Sample {
        Sample {
            series: format!("s{n}"),
            series_name: "test".into(),
            member_count: n,
            image: Picture {
                id: id.into(),
                hash: id.into(),
                path: id.into(),
                width: 100,
                height: 100,
            },
            truth: if positive {
                BTreeSet::from(["a".into()])
            } else {
                BTreeSet::new()
            },
            truth_source: "manual".into(),
            candidates: Vec::new(),
            missing_scores: 0,
            known: None,
        }
    }
    #[test]
    fn sampling_is_seeded_balanced_and_without_duplicates() {
        let pool = (0..60)
            .map(|i| s(&format!("i{i}"), [3, 10, 20][i % 3], i % 2 == 0))
            .collect::<Vec<_>>();
        let a = stratify(pool.clone(), 24, 36);
        let b = stratify(pool.clone(), 24, 36);
        let c = stratify(pool, 24, 37);
        let ids = |v: Vec<Sample>| v.into_iter().map(|s| s.image.id).collect::<BTreeSet<_>>();
        assert_eq!(ids(a.clone()), ids(b));
        assert_ne!(ids(a.clone()), ids(c));
        assert_eq!(ids(a.clone()).len(), 24);
        assert_eq!(a.iter().filter(|s| s.truth.is_empty()).count(), 12);
        for n in [3, 10, 20] {
            assert_eq!(a.iter().filter(|s| s.member_count == n).count(), 8);
        }
    }
    #[test]
    fn cap_includes_cache_and_pending_requests() {
        let usage = Usage {
            input: 1000,
            output: 200,
            cache_write: 2000,
            cache_read: 3000,
        };
        let actual = usage.cost(SONNET);
        assert!((actual - 0.0096).abs() < 1e-10);
        let r = Record {
            key: "a".into(),
            model: SONNET.into(),
            sample: s("x", 3, true),
            usage,
            usd: actual,
            answer: None,
            error: None,
            request_id: None,
        };
        let reservations = vec![
            Reservation {
                key: "a".into(),
                model: SONNET.into(),
                usd: reserve(SONNET),
            },
            Reservation {
                key: "b".into(),
                model: HAIKU.into(),
                usd: reserve(HAIKU),
            },
        ];
        assert!((accounted(&[r], &reservations).unwrap() - actual - reserve(HAIKU)).abs() < 1e-10);
        assert!(!can_spend(7.0, reserve(SONNET), 8.0));
        assert!(can_spend(5.0, reserve(SONNET), 8.0));
        assert!(!can_spend(8.0, 0.1, 50.0));
    }
    #[test]
    fn metrics_include_multiple_members_none_and_invalid() {
        let mut sample = s("x", 20, true);
        sample.truth.insert("b".into());
        let mut m = Metrics::default();
        m.add(&sample, Some(BTreeSet::from(["a".into(), "c".into()])), 0.1);
        m.add(&s("none", 3, false), Some(BTreeSet::new()), 0.2);
        m.add(&sample, None, 0.3);
        assert_eq!(
            (m.tp, m.fp, m.fn_, m.exact, m.correct_none, m.n, m.valid),
            (1, 1, 3, 1, 1, 3, 2)
        );
        assert!((m.usd - 0.6).abs() < 1e-10);
    }
    #[test]
    fn structured_answers_preserve_multiple_confidences_and_reject_false_none() {
        let mut sample = s("x", 3, true);
        sample.candidates = vec![
            Member {
                id: "a".into(),
                name: "A name".into(),
                references: Vec::new(),
            },
            Member {
                id: "b".into(),
                name: "B name".into(),
                references: Vec::new(),
            },
        ];
        let message = |answer: Value| json!({"stop_reason":"end_turn","content":[{"type":"text","text":answer.to_string()}]});
        let parsed=parse_answer(&message(json!({"present":[{"label":"A","confidence":0.8},{"label":"B","confidence":0.95}],"none":false})),&sample).unwrap();
        assert_eq!(parsed.present.len(), 2);
        assert_eq!(parsed.present[0].confidence, 0.8);
        assert!(
            parse_answer(&message(json!({"present":[],"none":true})), &sample)
                .unwrap()
                .none
        );
        assert!(parse_answer(
            &message(json!({"present":[{"label":"A","confidence":0.8}],"none":true})),
            &sample
        )
        .is_err());
    }
}
