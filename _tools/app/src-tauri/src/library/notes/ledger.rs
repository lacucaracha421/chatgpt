//! Ledger (가계부) notes inside the encrypted payload: a `ledger` note (income, recurring
//! charges, plans) plus one hidden `ledger-month` note per calendar month (entries).
//! Types, limits, the text fallback body, the fork-on-collision merge and the month-note
//! id (docs/research/budget-notes-design-20260925.md §4). Charge dates and month figures
//! are computed only by the shared TypeScript (`src/notes/ledger/`). Android ports the
//! same rules; all run the shared fixtures in `tests/fixtures/notes-v2/`.
use super::model::{self, Content};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub const LEDGER: &str = "ledger";
pub const LEDGER_MONTH: &str = "ledger-month";
pub const MAX_RECURRING: usize = 200;
pub const MAX_PLANNED: usize = 300;
/// Per month note; 300 worst-case entries (UUID ids and refs, ISO timestamps, 100-char
/// Korean names) plus a full fallback body stay under the 256 KiB plaintext limit.
pub const MAX_ENTRIES: usize = 300;
pub const MAX_NAME_CHARS: usize = 100;
pub const MAX_MEMO_CHARS: usize = 500;
/// Amounts are integer won, 0 <= x < 10^12.
pub const AMOUNT_BOUND: u64 = 1_000_000_000_000;
pub const MAX_EVERY: u64 = 120;
pub const MAX_FALLBACK_BYTES: usize = 24 * 1024;

pub fn is_ledger_kind(kind: &str) -> bool {
    kind == LEDGER || kind == LEDGER_MONTH
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// A recurring charge; `start` is the first paid charge and the day anchor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recurring {
    pub id: String,
    pub name: String,
    pub amount: u64,
    pub every: u64,
    pub unit: String,
    pub start: String,
    #[serde(default)]
    pub trial: bool,
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub memo: String,
    pub order: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_of: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Something to buy; `month: None` is 언젠가. Done is derived from entries, never stored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Planned {
    pub id: String,
    pub name: String,
    pub amount: u64,
    #[serde(default)]
    pub month: Option<String>,
    #[serde(default)]
    pub memo: String,
    #[serde(default)]
    pub dropped: bool,
    pub order: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_of: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The derived charge an entry confirms (or, with amount 0, skips).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChargeRef {
    pub id: String,
    pub date: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One record of a month note; `in` marks money in (a refund or one-off income).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub date: String,
    pub amount: u64,
    pub name: String,
    #[serde(rename = "in", default, skip_serializing_if = "is_false")]
    pub money_in: bool,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurring: Option<ChargeRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_of: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Keys of a collection entry that the merge knows (all but `id` and `order`).
pub trait Keyed: Clone + Serialize + DeserializeOwned {
    const FIELDS: &'static [&'static str];
    fn id(&self) -> &str;
    fn extra_mut(&mut self) -> &mut Map<String, Value>;
}
impl Keyed for Recurring {
    const FIELDS: &'static [&'static str] = &[
        "name", "amount", "every", "unit", "start", "trial", "until", "memo", "forkOf",
    ];
    fn id(&self) -> &str {
        &self.id
    }
    fn extra_mut(&mut self) -> &mut Map<String, Value> {
        &mut self.extra
    }
}
impl Keyed for Planned {
    const FIELDS: &'static [&'static str] =
        &["name", "amount", "month", "memo", "dropped", "forkOf"];
    fn id(&self) -> &str {
        &self.id
    }
    fn extra_mut(&mut self) -> &mut Map<String, Value> {
        &mut self.extra
    }
}
impl Keyed for Entry {
    const FIELDS: &'static [&'static str] = &[
        "date",
        "amount",
        "name",
        "in",
        "createdAt",
        "recurring",
        "planned",
        "forkOf",
    ];
    fn id(&self) -> &str {
        &self.id
    }
    fn extra_mut(&mut self) -> &mut Map<String, Value> {
        &mut self.extra
    }
}

/// The UI never sees unknown per-entry keys; a save restores them by id.
pub fn restore_extra<T: Keyed>(entries: &mut [T], old: Option<&Vec<T>>) {
    let Some(old) = old else { return };
    for entry in entries.iter_mut() {
        if !entry.extra_mut().is_empty() {
            continue;
        }
        if let Some(prev) = old.iter().find(|o| o.id() == entry.id()) {
            let extra = prev.clone().extra_mut().clone();
            *entry.extra_mut() = extra;
        }
    }
}

pub fn clear_extra(content: &mut Content) {
    for r in content.recurring.iter_mut().flatten() {
        r.extra.clear();
    }
    for p in content.planned.iter_mut().flatten() {
        p.extra.clear();
    }
    for e in content.entries.iter_mut().flatten() {
        e.extra.clear();
    }
}

// ---------------------------------------------------------------------------------------
// Calendar strings

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}
fn digits(text: &str) -> Option<u32> {
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}
/// `YYYY-MM`.
pub fn valid_month(value: &str) -> bool {
    value.len() == 7
        && value.is_ascii()
        && value.as_bytes()[4] == b'-'
        && digits(&value[..4]).is_some()
        && digits(&value[5..]).is_some_and(|m| (1..=12).contains(&m))
}
/// `YYYY-MM-DD`, a real calendar date.
pub fn valid_date(value: &str) -> bool {
    value.len() == 10
        && value.is_ascii()
        && value.as_bytes()[7] == b'-'
        && valid_month(&value[..7])
        && digits(&value[8..]).is_some_and(|d| {
            d >= 1
                && d <= days_in_month(
                    digits(&value[..4]).unwrap_or(0),
                    digits(&value[5..7]).unwrap_or(1),
                )
        })
}

// ---------------------------------------------------------------------------------------
// Validation

fn chars(text: &str) -> usize {
    text.chars().count()
}

fn check_list<T: Keyed>(
    list: &[T],
    max: usize,
    too_many: &'static str,
    malformed: &'static str,
    fork_of: impl Fn(&T) -> Option<&String>,
    check: impl Fn(&T) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    if list.len() > max {
        return Err(too_many);
    }
    let mut ids = HashSet::new();
    for entry in list {
        if !model::valid_key(entry.id())
            || !ids.insert(entry.id().to_owned())
            || fork_of(entry).is_some_and(|f| !model::valid_key(f))
        {
            return Err(malformed);
        }
        check(entry)?;
    }
    Ok(())
}

const AMOUNT: &str = "금액은 0원 이상 1조 원 미만의 정수로 입력해 주세요.";
const NAMES: &str = "이름은 100자, 메모는 500자까지 쓸 수 있습니다.";
fn amount_ok(amount: u64) -> Result<(), &'static str> {
    (amount < AMOUNT_BOUND).then_some(()).ok_or(AMOUNT)
}

/// Every ledger limit (design §4.4). Messages are shown to the user.
pub fn validate(c: &Content) -> Result<(), &'static str> {
    if let Some(Some(income)) = c.income {
        amount_ok(income)?;
    }
    if let Some(list) = &c.recurring {
        check_list(
            list,
            MAX_RECURRING,
            "고정·구독은 200개까지 저장할 수 있습니다.",
            "고정·구독 형식이 올바르지 않습니다.",
            |r| r.fork_of.as_ref(),
            |r| {
                if chars(&r.name) > MAX_NAME_CHARS || chars(&r.memo) > MAX_MEMO_CHARS {
                    return Err(NAMES);
                }
                amount_ok(r.amount)?;
                if !(1..=MAX_EVERY).contains(&r.every)
                    || !matches!(r.unit.as_str(), "week" | "month" | "year")
                {
                    return Err("주기는 1~120 사이로 입력해 주세요.");
                }
                if !valid_date(&r.start)
                    || r.until.as_deref().is_some_and(|u| !valid_date(u))
                    || !model::valid_key(&r.order)
                {
                    return Err("고정·구독 날짜가 올바르지 않습니다.");
                }
                Ok(())
            },
        )?;
    }
    if let Some(list) = &c.planned {
        check_list(
            list,
            MAX_PLANNED,
            "계획은 300개까지 저장할 수 있습니다.",
            "계획 형식이 올바르지 않습니다.",
            |p| p.fork_of.as_ref(),
            |p| {
                if chars(&p.name) > MAX_NAME_CHARS || chars(&p.memo) > MAX_MEMO_CHARS {
                    return Err(NAMES);
                }
                amount_ok(p.amount)?;
                if p.month.as_deref().is_some_and(|m| !valid_month(m))
                    || !model::valid_key(&p.order)
                {
                    return Err("계획 형식이 올바르지 않습니다.");
                }
                Ok(())
            },
        )?;
    }
    if c.kind() == LEDGER_MONTH
        && !(c.ledger.as_deref().is_some_and(model::valid_key)
            && c.month.as_deref().is_some_and(valid_month))
    {
        return Err("가계부 월 기록 형식이 올바르지 않습니다.");
    }
    if let Some(list) = &c.entries {
        check_list(
            list,
            MAX_ENTRIES,
            "기록은 500개까지 저장할 수 있습니다.",
            "기록 형식이 올바르지 않습니다.",
            |e| e.fork_of.as_ref(),
            |e| {
                if chars(&e.name) > MAX_NAME_CHARS {
                    return Err("기록 이름은 100자까지 쓸 수 있습니다.");
                }
                amount_ok(e.amount)?;
                if !valid_date(&e.date) || !model::valid_key(&e.created_at) {
                    return Err("기록 날짜가 올바르지 않습니다.");
                }
                if e.recurring
                    .as_ref()
                    .is_some_and(|r| !model::valid_key(&r.id) || !valid_date(&r.date))
                    || e.planned.as_deref().is_some_and(|p| !model::valid_key(p))
                {
                    return Err("기록 형식이 올바르지 않습니다.");
                }
                Ok(())
            },
        )?;
    }
    if is_ledger_kind(c.kind()) && c.body.len() > MAX_FALLBACK_BYTES {
        return Err("가계부 요약이 너무 깁니다.");
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Canonical order and the text fallback body

fn sort_by_order<T>(list: &mut [T], key: impl Fn(&T) -> (&str, &str)) {
    list.sort_by(|a, b| key(a).cmp(&key(b)));
}
/// Entries: date desc, createdAt desc, then id.
fn sort_entries(list: &mut [Entry]) {
    list.sort_by(|a, b| {
        b.date
            .cmp(&a.date)
            .then_with(|| b.created_at.cmp(&a.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// Canonical order, the always-present keys, month notes archived, and the fallback body.
pub fn normalize(c: &mut Content) {
    match c.kind() {
        LEDGER => {
            c.income.get_or_insert(None);
            sort_by_order(c.recurring.get_or_insert_with(Vec::new), |r| {
                (&r.order, &r.id)
            });
            sort_by_order(c.planned.get_or_insert_with(Vec::new), |p| {
                (&p.order, &p.id)
            });
            c.body = ledger_fallback(
                &c.title,
                c.income.flatten(),
                c.recurring.as_deref().unwrap_or(&[]),
                c.planned.as_deref().unwrap_or(&[]),
            );
        }
        LEDGER_MONTH => {
            c.income.get_or_insert(None);
            sort_entries(c.entries.get_or_insert_with(Vec::new));
            c.archived = true;
            c.body = month_fallback(
                c.month.as_deref().unwrap_or(""),
                c.income.flatten(),
                c.entries.as_deref().unwrap_or(&[]),
            );
        }
        _ => {}
    }
}

/// 2300000 → "₩2,300,000".
pub fn won(amount: u64) -> String {
    let digits = amount.to_string();
    let mut out = String::from("₩");
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn words(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
}

fn month_label(month: &str) -> String {
    if valid_month(month) {
        format!(
            "{}년 {}월",
            digits(&month[..4]).unwrap_or(0),
            digits(&month[5..]).unwrap_or(0)
        )
    } else {
        month.to_owned()
    }
}

fn cycle_word(every: u64, unit: &str) -> String {
    match (every, unit) {
        (1, "week") => "매주".into(),
        (1, "month") => "매월".into(),
        (1, "year") => "매년".into(),
        (n, "week") => format!("{n}주마다"),
        (n, "month") => format!("{n}개월마다"),
        (n, _) => format!("{n}년마다"),
    }
}

/// Over 24 KiB, keeps the longest prefix of lines that fits with "… N건 더" (N = dropped
/// list lines).
fn fit_lines(lines: Vec<String>) -> String {
    let full = lines.join("\n");
    if full.len() <= MAX_FALLBACK_BYTES {
        return full;
    }
    let mut after = vec![0usize; lines.len() + 1];
    for i in (0..lines.len()).rev() {
        after[i] = after[i + 1] + usize::from(lines[i].starts_with("- "));
    }
    let suffix = |p: usize| format!("… {}건 더", after[p]);
    let (mut best, mut prefix) = (0, 0);
    for p in 0..=lines.len() {
        if p > 0 {
            prefix += lines[p - 1].len() + usize::from(p > 1);
        }
        if prefix + usize::from(p > 0) + suffix(p).len() <= MAX_FALLBACK_BYTES {
            best = p;
        }
    }
    let mut kept = lines[..best].to_vec();
    kept.push(suffix(best));
    kept.join("\n")
}

pub fn ledger_fallback(
    title: &str,
    income: Option<u64>,
    recurring: &[Recurring],
    planned: &[Planned],
) -> String {
    let title = model::one_line(title);
    let mut lines = vec![format!(
        "# {}",
        if title.is_empty() {
            "가계부"
        } else {
            &title
        }
    )];
    if let Some(income) = income {
        lines.push(format!("월 수입 {}", won(income)));
    }
    if !recurring.is_empty() {
        let mut sorted: Vec<&Recurring> = recurring.iter().collect();
        sorted.sort_by(|a, b| (&a.order, &a.id).cmp(&(&b.order, &b.id)));
        lines.push(String::new());
        lines.push("## 고정·구독".into());
        for r in sorted {
            let mut line = format!(
                "- {} · {} · {}부터",
                words(&[&model::one_line(&r.name), &won(r.amount)]),
                cycle_word(r.every, &r.unit),
                r.start
            );
            if r.trial {
                line.push_str(" · 무료 체험");
            }
            if let Some(until) = r.until.as_deref().filter(|u| !u.is_empty()) {
                line.push_str(&format!(" · {until} 만료"));
            }
            lines.push(line);
        }
    }
    if !planned.is_empty() {
        let mut sorted: Vec<&Planned> = planned.iter().collect();
        sorted.sort_by(|a, b| (&a.order, &a.id).cmp(&(&b.order, &b.id)));
        lines.push(String::new());
        lines.push("## 사고 싶은 것".into());
        for p in sorted {
            lines.push(format!(
                "- {} · {}{}",
                words(&[&model::one_line(&p.name), &won(p.amount)]),
                p.month.as_deref().unwrap_or("언젠가"),
                if p.dropped {
                    " · 안 사기로 함"
                } else {
                    ""
                }
            ));
        }
    }
    fit_lines(lines)
}

pub fn month_fallback(month: &str, income: Option<u64>, entries: &[Entry]) -> String {
    let mut lines = vec![format!(
        "# {} 기록 ({}건)",
        month_label(month),
        entries.len()
    )];
    if let Some(income) = income {
        lines.push(format!("수입 {}", won(income)));
    }
    let mut sorted = entries.to_vec();
    sort_entries(&mut sorted);
    for e in &sorted {
        let head = format!(
            "{} {}{}",
            e.date.get(5..).unwrap_or(""),
            if e.money_in { "+" } else { "" },
            won(e.amount)
        );
        lines.push(format!("- {}", words(&[&head, &model::one_line(&e.name)])));
    }
    fit_lines(lines)
}

// ---------------------------------------------------------------------------------------
// Ids

/// UUID v4 layout (version nibble 4, RFC 4122 variant) of the first 16 bytes, so derived
/// ids look like any other note id.
fn uuid_shape(digest: &[u8]) -> String {
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = to_hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}
fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hmac(key: &[u8], message: &[u8]) -> ring::hmac::Tag {
    ring::hmac::sign(&ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key), message)
}

/// HKDF-SHA256 (RFC 5869, one output block) of the notes key: the month-id key is never the
/// AES-GCM key itself.
fn month_key(notes_key: &[u8]) -> ring::hmac::Tag {
    let prk = hmac(b"lakomics-notes-ledger:1", notes_key);
    hmac(prk.as_ref(), b"ledger-month-id\x01")
}

/// Deterministic month-note id, so two offline devices creating the same month converge on
/// one note. A keyed HMAC keeps the server from labelling months.
pub fn month_id(notes_key: &[u8], ledger: &str, month: &str) -> String {
    let tag = hmac(
        month_key(notes_key).as_ref(),
        format!("lakomics-ledger-month:1:{ledger}:{month}").as_bytes(),
    );
    uuid_shape(tag.as_ref())
}

/// Id of the local copy of an item both sides changed differently. `stamp` is
/// "<local updatedAt>:<remote updatedAt>", so a later collision gets a new id.
pub fn fork_id(stamp: &str, id: &str) -> String {
    uuid_shape(&Sha256::digest(
        format!("lakomics-ledger-fork:1:{stamp}:{id}").as_bytes(),
    ))
}

/// Canonical lowercase hyphenated UUID text (the form every client writes).
pub fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

// ---------------------------------------------------------------------------------------
// Merge

/// A pulled month note meeting a local copy with no merge base (both devices created the
/// same month offline): merge against an empty month so both sides' entries survive.
pub fn empty_month_base(local: &Content, remote: &Content) -> Option<Content> {
    if local.kind() != LEDGER_MONTH
        || remote.kind() != LEDGER_MONTH
        || local.ledger.is_none()
        || local.ledger != remote.ledger
        || local.month != remote.month
    {
        return None;
    }
    let mut base = Content::new("");
    base.schema = Some(model::SUPPORTED_SCHEMA);
    base.kind = Some(LEDGER_MONTH.into());
    base.ledger = local.ledger.clone();
    base.month = local.month.clone();
    base.income = Some(None);
    base.entries = Some(vec![]);
    base.archived = true;
    Some(base)
}

type Object = Map<String, Value>;

fn object<T: Serialize>(value: &T) -> Option<Object> {
    match serde_json::to_value(value).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// A content change (not a pure move or an unknown key) relative to `base`.
fn edited(fields: &[&str], side: &Object, base: &Object) -> bool {
    fields.iter().any(|k| side.get(*k) != base.get(*k))
}

/// Per key: one-side rule; `order` and unknown keys take remote on a collision; `None`
/// when a known field collides (the item forks).
fn merge_object(fields: &[&str], base: &Object, local: &Object, remote: &Object) -> Option<Object> {
    let mut merged = Object::new();
    for key in remote.keys().chain(local.keys()).chain(base.keys()) {
        if merged.contains_key(key) {
            continue;
        }
        let (b, l, r) = (base.get(key), local.get(key), remote.get(key));
        let value = if l == r || l == b {
            r
        } else if r == b {
            l
        } else if fields.contains(&key.as_str()) {
            return None;
        } else {
            r
        };
        if let Some(value) = value {
            merged.insert(key.clone(), value.clone());
        }
    }
    Some(merged)
}

fn fork(local: &Object, id: &str, stamp: &str) -> Object {
    let mut copy = local.clone();
    copy.insert("id".into(), Value::String(fork_id(stamp, id)));
    copy.insert("forkOf".into(), Value::String(id.into()));
    copy
}

/// Per-id merge of one collection. A field collision keeps both versions: the remote one
/// keeps the id, the local one is forked (`stamp` = the local note's `updatedAt`).
fn merge_list<T: Keyed>(base: &[T], local: &[T], remote: &[T], stamp: &str) -> Option<Vec<T>> {
    let objects = |list: &[T]| -> Option<Vec<(String, Object)>> {
        list.iter()
            .map(|e| Some((e.id().to_owned(), object(e)?)))
            .collect()
    };
    let (b, l, r) = (objects(base)?, objects(local)?, objects(remote)?);
    let index =
        |list: &[(String, Object)]| -> HashMap<String, Object> { list.iter().cloned().collect() };
    let (bi, li, ri) = (index(&b), index(&l), index(&r));
    let mut seen = HashSet::new();
    let mut merged: Vec<Object> = vec![];
    for (id, _) in r.iter().chain(&l).chain(&b) {
        if !seen.insert(id.clone()) {
            continue;
        }
        match (bi.get(id), li.get(id), ri.get(id)) {
            (Some(b), Some(l), Some(r)) => match merge_object(T::FIELDS, b, l, r) {
                Some(m) => merged.push(m),
                None => merged.extend([r.clone(), fork(l, id, stamp)]),
            },
            // Deleted on one side: deletion wins unless the other side edited it.
            (Some(b), None, Some(r)) => merged.extend(edited(T::FIELDS, r, b).then(|| r.clone())),
            (Some(b), Some(l), None) => merged.extend(edited(T::FIELDS, l, b).then(|| l.clone())),
            (None, Some(l), Some(r)) => {
                let mut l_moved = l.clone();
                if let Some(order) = r.get("order") {
                    l_moved.insert("order".into(), order.clone());
                }
                if l_moved == *r {
                    merged.push(r.clone());
                } else {
                    merged.extend([r.clone(), fork(l, id, stamp)]);
                }
            }
            (None, Some(l), None) => merged.push(l.clone()),
            (None, None, Some(r)) => merged.push(r.clone()),
            _ => {}
        }
    }
    merged
        .into_iter()
        .map(|m| serde_json::from_value(Value::Object(m)).ok())
        .collect()
}

fn merge_opt_list<T: Keyed>(
    base: &Option<Vec<T>>,
    local: &Option<Vec<T>>,
    remote: &Option<Vec<T>>,
    stamp: &str,
) -> Option<Option<Vec<T>>> {
    if local.is_none() && remote.is_none() {
        return Some(None);
    }
    let empty = vec![];
    Some(Some(merge_list(
        base.as_ref().unwrap_or(&empty),
        local.as_ref().unwrap_or(&empty),
        remote.as_ref().unwrap_or(&empty),
        stamp,
    )?))
}

/// Three-way merge when any side is a ledger type. `None` (keep both copies) only when the
/// type, ledger or month differ on any side or the result breaks a limit.
pub fn merge(base: &Content, local: &Content, remote: &Content) -> Option<Content> {
    let same = |f: fn(&Content) -> Option<&str>| f(base) == f(local) && f(local) == f(remote);
    if !(same(|c| Some(c.kind())) && same(|c| c.ledger.as_deref()) && same(|c| c.month.as_deref()))
    {
        return None;
    }
    let stamp = &format!("{}:{}", local.updated_at, remote.updated_at);
    let mut merged = Content {
        schema: local.schema.max(remote.schema),
        kind: remote.kind.clone(),
        title: model::three_or(
            &base.title,
            &local.title,
            &remote.title,
            remote.title.clone(),
        ),
        body: String::new(), // derived by normalize()
        memo: model::three_or(&base.memo, &local.memo, &remote.memo, remote.memo.clone()),
        color: model::three_or(
            &base.color,
            &local.color,
            &remote.color,
            remote.color.clone(),
        ),
        labels: model::merge_labels(&base.labels, &local.labels, &remote.labels),
        items: model::three_or(
            &base.items,
            &local.items,
            &remote.items,
            remote.items.clone(),
        ),
        fields: model::three_or(
            &base.fields,
            &local.fields,
            &remote.fields,
            remote.fields.clone(),
        ),
        ledger: remote.ledger.clone(),
        month: remote.month.clone(),
        income: model::three_or(&base.income, &local.income, &remote.income, remote.income),
        recurring: merge_opt_list(&base.recurring, &local.recurring, &remote.recurring, stamp)?,
        planned: merge_opt_list(&base.planned, &local.planned, &remote.planned, stamp)?,
        entries: merge_opt_list(&base.entries, &local.entries, &remote.entries, stamp)?,
        pinned: model::three_or(&base.pinned, &local.pinned, &remote.pinned, remote.pinned),
        deleted: model::three_or(&base.deleted, &local.deleted, &remote.deleted, false),
        archived: model::three_or(&base.archived, &local.archived, &remote.archived, false),
        created_at: model::three_or(
            &base.created_at,
            &local.created_at,
            &remote.created_at,
            remote.created_at.clone(),
        ),
        updated_at: local.updated_at.clone().max(remote.updated_at.clone()),
        extra: model::merge_extra(&base.extra, &local.extra, &remote.extra),
    };
    merged.normalize();
    merged.validate().ok()?;
    Some(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/fixtures/notes-v2")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }
    fn parse(value: &Value) -> Content {
        serde_json::from_value(value.clone()).unwrap()
    }
    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn month_and_fork_ids_match_the_shared_vectors() {
        let file = fixture("ledger-vectors.json");
        let v = &file["monthId"];
        let id = month_id(
            &unhex(v["key"].as_str().unwrap()),
            v["ledger"].as_str().unwrap(),
            v["month"].as_str().unwrap(),
        );
        assert_eq!(id, v["id"].as_str().unwrap());
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        let f = &file["forkId"];
        assert_eq!(
            fork_id(f["stamp"].as_str().unwrap(), f["id"].as_str().unwrap()),
            f["fork"].as_str().unwrap()
        );
    }

    #[test]
    fn a_month_without_a_base_merges_against_an_empty_month() {
        let file = fixture("ledger-vectors.json");
        for v in file["emptyBase"]["vectors"].as_array().unwrap() {
            let name = v["name"].as_str().unwrap();
            let (local, remote) = (parse(&v["local"]), parse(&v["remote"]));
            let result =
                empty_month_base(&local, &remote).and_then(|b| model::merge(&b, &local, &remote));
            if v["expected"].get("conflict").is_some() {
                assert!(result.is_none(), "{name}");
            } else {
                assert_eq!(
                    serde_json::to_value(result.unwrap()).unwrap(),
                    v["expected"],
                    "{name}"
                );
            }
        }
    }

    #[test]
    fn long_fallbacks_are_cut_like_the_shared_vectors() {
        let file = fixture("ledger-vectors.json");
        let summary = |body: &str| {
            let lines: Vec<&str> = body.split('\n').collect();
            serde_json::json!({"bytes": body.len(), "lines": lines.len(), "first": lines[0], "last": lines[lines.len() - 1]})
        };
        let name = "가".repeat(100);
        let entries: Vec<Entry> = (0..500u64)
            .map(|i| Entry {
                id: format!("e{i:03}"),
                date: format!("2026-09-{:02}", 1 + i % 30),
                amount: 1000 + i,
                name: name.clone(),
                money_in: false,
                created_at: "2026-09-01T00:00:00Z".into(),
                recurring: None,
                planned: None,
                fork_of: None,
                extra: Map::new(),
            })
            .collect();
        assert_eq!(
            summary(&month_fallback("2026-09", None, &entries)),
            file["truncation"]["month"]
        );
        let recurring: Vec<Recurring> = (0..200u64)
            .map(|i| Recurring {
                id: format!("r{i:03}"),
                name: name.clone(),
                amount: 10000 + i,
                every: 1,
                unit: "month".into(),
                start: "2026-01-15".into(),
                trial: false,
                until: None,
                memo: String::new(),
                order: format!("a{i:03}"),
                fork_of: None,
                extra: Map::new(),
            })
            .collect();
        let planned: Vec<Planned> = (0..300u64)
            .map(|i| Planned {
                id: format!("p{i:03}"),
                name: name.clone(),
                amount: 20000 + i,
                month: None,
                memo: String::new(),
                dropped: false,
                order: format!("a{i:03}"),
                fork_of: None,
                extra: Map::new(),
            })
            .collect();
        let body = ledger_fallback("가계부", Some(2_300_000), &recurring, &planned);
        assert_eq!(summary(&body), file["truncation"]["ledger"]);
    }

    #[test]
    fn the_entry_limit_fits_worst_case_entries_in_the_plaintext_limit() {
        let uuid = |i: usize| format!("{i:08}-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let worst = |i: usize| Entry {
            id: uuid(i),
            date: "2026-09-25".into(),
            amount: AMOUNT_BOUND - 1,
            name: "가".repeat(MAX_NAME_CHARS),
            money_in: true,
            created_at: "2026-09-25T12:34:56.789Z".into(),
            recurring: Some(ChargeRef {
                id: uuid(i + 1000),
                date: "2026-09-25".into(),
                extra: Map::new(),
            }),
            planned: Some(uuid(i + 2000)),
            fork_of: Some(uuid(i + 3000)),
            extra: Map::new(),
        };
        let mut c = Content::new("2026-09-25T12:34:56.789Z");
        c.kind = Some(LEDGER_MONTH.into());
        c.title = "가계부 2026년 9월".into();
        c.ledger = Some(uuid(9));
        c.month = Some("2026-09".into());
        c.income = Some(Some(AMOUNT_BOUND - 1));
        c.entries = Some((0..MAX_ENTRIES).map(worst).collect());
        c.normalize();
        assert!(c.validate().is_ok());
        let size = serde_json::to_vec(&c).unwrap().len();
        assert!(
            size < model::MAX_PLAINTEXT_BYTES * 9 / 10,
            "{size} bytes leaves room for unknown keys"
        );
    }

    #[test]
    fn ids_are_canonical_and_charge_refs_keep_unknown_keys() {
        assert!(canonical_uuid("11111111-2222-4333-8444-555555555555"));
        assert!(!canonical_uuid("11111111-2222-4333-8444-55555555555A"));
        assert!(!canonical_uuid("11111111222243338444555555555555"));
        assert!(!canonical_uuid("{11111111-2222-4333-8444-555555555555}"));
        let id = month_id(&[1; 32], "11111111-2222-4333-8444-555555555555", "2026-09");
        assert!(canonical_uuid(&id) && id.as_bytes()[14] == b'4');
        assert!(matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        assert_ne!(fork_id("a:b", "x"), fork_id("a:c", "x"));
        let entry: Entry = serde_json::from_value(serde_json::json!({"id":"e","date":"2026-09-01","amount":1,"name":"","createdAt":"c","recurring":{"id":"r","date":"2026-09-01","note":"x"}})).unwrap();
        assert_eq!(
            serde_json::to_value(&entry).unwrap()["recurring"]["note"],
            "x"
        );
    }

    #[test]
    fn limits_and_calendar_strings() {
        let mut c = Content::new("now");
        c.kind = Some(LEDGER.into());
        c.normalize();
        assert!(c.validate().is_ok());
        assert_eq!(c.body, "# 가계부");
        assert_eq!(c.income, Some(None));
        let r = |every: u64, unit: &str, start: &str| Recurring {
            id: "r".into(),
            name: "n".into(),
            amount: 1,
            every,
            unit: unit.into(),
            start: start.into(),
            trial: false,
            until: None,
            memo: String::new(),
            order: "V".into(),
            fork_of: None,
            extra: Map::new(),
        };
        for bad in [
            r(0, "month", "2026-01-01"),
            r(121, "month", "2026-01-01"),
            r(1, "day", "2026-01-01"),
            r(1, "month", "2026-02-29"),
        ] {
            c.recurring = Some(vec![bad]);
            assert!(c.validate().is_err());
        }
        c.recurring = Some(vec![r(1, "week", "2028-02-29")]);
        assert!(c.validate().is_ok());
        c.income = Some(Some(AMOUNT_BOUND));
        assert!(c.validate().is_err());
        c.income = Some(Some(AMOUNT_BOUND - 1));
        assert!(c.validate().is_ok());
        c.recurring = Some(
            (0..=MAX_RECURRING)
                .map(|i| Recurring {
                    id: format!("r{i}"),
                    ..r(1, "month", "2026-01-01")
                })
                .collect(),
        );
        assert!(c.validate().is_err());
        let mut m = Content::new("now");
        m.kind = Some(LEDGER_MONTH.into());
        m.normalize();
        assert!(
            m.validate().is_err(),
            "a month note needs its ledger and month"
        );
        assert!(m.archived);
        assert!(valid_month("2026-12") && !valid_month("2026-13") && !valid_month("２026-01"));
        assert!(valid_date("2024-02-29") && !valid_date("2100-02-29") && !valid_date("2026-04-31"));
        assert_eq!(won(0), "₩0");
        assert_eq!(won(999_999_999_999), "₩999,999,999,999");
    }
}
