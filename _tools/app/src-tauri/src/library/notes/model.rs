//! Notes v2 plaintext schema (inside the encrypted payload only), its limits, the
//! plaintext fallback body for pre-v2 clients, and the three-way merge.
//!
//! The server never sees any of this. Android ports the same rules; both run the shared
//! fixtures in `tests/fixtures/notes-v2/`.
use super::ledger::{self, Planned, Recurring};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

pub const SUPPORTED_SCHEMA: u64 = 2;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_BODY_BYTES: usize = 128 * 1024;
pub const MAX_PLAINTEXT_BYTES: usize = 256 * 1024;
pub const MAX_ITEMS: usize = 500;
pub const MAX_ITEM_CHARS: usize = 1000;
pub const MAX_LABELS: usize = 20;
pub const MAX_LABEL_CHARS: usize = 40;
pub const MAX_FIELDS: usize = 200;
pub const MAX_FIELD_LABEL_CHARS: usize = 100;
pub const MAX_FIELD_VALUE_CHARS: usize = 4000;
const MAX_KEY_LEN: usize = 64;

pub const TEXT: &str = "text";
pub const CHECKLIST: &str = "checklist";
pub const SECRET: &str = "secret";
pub use ledger::{LEDGER, LEDGER_MONTH};

/// `Some(None)` for a present JSON null, so `"income": null` survives a round trip.
pub fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// A checklist item. Unknown keys written by newer clients survive in `extra`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub checked: bool,
    pub order: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A secret-note field (`label: value`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub id: String,
    pub label: String,
    pub value: String,
    pub order: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Decrypted note payload. v1 notes have no `schema`/`type`; they serialize with the
/// same keys in the same order as before. Unknown top-level keys survive in `extra`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<u64>,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub title: String,
    /// Markdown for text notes; for checklist and secret notes a derived fallback.
    pub body: String,
    /// Free text of a secret note (its `body` is the derived fallback).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<Item>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<Field>>,
    /// Month note: the ledger note it belongs to (immutable).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ledger: Option<String>,
    /// Month note: `YYYY-MM` (immutable).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub month: Option<String>,
    /// Ledger: default monthly income; month note: this month's income. Integer won or null.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub income: Option<Option<u64>>,
    /// Ledger: day of the month income arrives (1–31; past the month's end = its last day).
    /// Absent when not set, so payloads without it keep their exact shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub income_day: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurring: Option<Vec<Recurring>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned: Option<Vec<Planned>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<ledger::Entry>>,
    pub pinned: bool,
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Content {
    pub fn new(now: &str) -> Self {
        Self {
            schema: None,
            kind: None,
            title: String::new(),
            body: String::new(),
            memo: None,
            color: None,
            labels: vec![],
            items: None,
            fields: None,
            ledger: None,
            month: None,
            income: None,
            income_day: None,
            recurring: None,
            planned: None,
            entries: None,
            pinned: false,
            deleted: false,
            archived: false,
            created_at: now.into(),
            updated_at: now.into(),
            extra: Map::new(),
        }
    }

    /// `type`, with absent meaning a text note.
    pub fn kind(&self) -> &str {
        self.kind.as_deref().unwrap_or(TEXT)
    }

    /// False for a newer schema or an unknown type: such a note is read-only here.
    pub fn supported(&self) -> bool {
        self.schema.unwrap_or(1) <= SUPPORTED_SCHEMA
            && matches!(
                self.kind(),
                TEXT | CHECKLIST | SECRET | LEDGER | LEDGER_MONTH
            )
    }

    /// Recomputes derived data: canonical item/field order, the fallback body of
    /// checklist and secret notes, and the schema marker.
    pub fn normalize(&mut self) {
        match self.kind() {
            CHECKLIST => {
                let items = self.items.get_or_insert_with(Vec::new);
                sort_entries(items);
                self.body = checklist_fallback(items);
            }
            SECRET => {
                let fields = self.fields.get_or_insert_with(Vec::new);
                sort_entries(fields);
                self.body = secret_fallback(fields, self.memo.as_deref().unwrap_or(""));
            }
            _ => ledger::normalize(self),
        }
        if self.kind == Some(TEXT.into()) {
            self.kind = None;
        }
        let v2 = self.kind.is_some()
            || self.color.is_some()
            || !self.labels.is_empty()
            || self.archived
            || self.items.is_some()
            || self.fields.is_some()
            || self.memo.is_some();
        if v2 && self.schema.unwrap_or(1) < SUPPORTED_SCHEMA {
            self.schema = Some(SUPPORTED_SCHEMA);
        }
    }

    /// Enforces every Notes v2 limit. Messages are shown to the user.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.title.chars().count() > MAX_TITLE_CHARS || self.body.len() > MAX_BODY_BYTES {
            return Err("제목은 200자, 본문은 128 KiB까지 저장할 수 있습니다.");
        }
        if self.memo.as_ref().is_some_and(|m| m.len() > MAX_BODY_BYTES) {
            return Err("메모는 128 KiB까지 저장할 수 있습니다.");
        }
        if let Some(color) = &self.color {
            if color.is_empty()
                || color.len() > 24
                || !color.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
            {
                return Err("메모 색상이 올바르지 않습니다.");
            }
        }
        if self.labels.len() > MAX_LABELS {
            return Err("라벨은 메모마다 20개까지 붙일 수 있습니다.");
        }
        let mut seen = HashSet::new();
        for label in &self.labels {
            if label.trim() != label
                || label.is_empty()
                || label.chars().count() > MAX_LABEL_CHARS
                || label.chars().any(char::is_control)
            {
                return Err("라벨은 1~40자로 입력해 주세요.");
            }
            if !seen.insert(label_key(label)) {
                return Err("같은 라벨이 이미 있습니다.");
            }
        }
        if let Some(items) = &self.items {
            if items.len() > MAX_ITEMS {
                return Err("체크리스트 항목은 500개까지 저장할 수 있습니다.");
            }
            let mut ids = HashSet::new();
            for item in items {
                if !valid_key(&item.id) || !valid_key(&item.order) || !ids.insert(&item.id) {
                    return Err("체크리스트 항목 형식이 올바르지 않습니다.");
                }
                if item.text.chars().count() > MAX_ITEM_CHARS {
                    return Err("체크리스트 항목은 1000자까지 입력할 수 있습니다.");
                }
            }
        }
        if let Some(fields) = &self.fields {
            if fields.len() > MAX_FIELDS {
                return Err("암호 메모 항목은 200개까지 저장할 수 있습니다.");
            }
            let mut ids = HashSet::new();
            for field in fields {
                if !valid_key(&field.id) || !valid_key(&field.order) || !ids.insert(&field.id) {
                    return Err("암호 메모 항목 형식이 올바르지 않습니다.");
                }
                if field.label.chars().count() > MAX_FIELD_LABEL_CHARS
                    || field.value.chars().count() > MAX_FIELD_VALUE_CHARS
                {
                    return Err("암호 메모 항목 이름은 100자, 값은 4000자까지 입력할 수 있습니다.");
                }
            }
        }
        ledger::validate(self)?;
        let size = serde_json::to_vec(self)
            .map(|v| v.len())
            .unwrap_or(usize::MAX);
        if size > MAX_PLAINTEXT_BYTES {
            return Err("메모가 너무 큽니다. 256 KiB 이하로 줄여 주세요.");
        }
        Ok(())
    }
}

/// Ids and fractional order keys: short printable ASCII.
pub(super) fn valid_key(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_KEY_LEN && value.bytes().all(|b| b.is_ascii_graphic())
}

/// Case-insensitive label identity. Clients normalize labels to NFC before saving.
pub fn label_key(label: &str) -> String {
    label.to_lowercase()
}

trait Entry: Clone + PartialEq {
    fn id(&self) -> &str;
    fn order(&self) -> &str;
    /// A content change (not a pure move) relative to `base`.
    fn edited(&self, base: &Self) -> bool;
    /// Per-attribute merge; `None` is an unresolvable collision.
    fn merge3(base: &Self, local: &Self, remote: &Self) -> Option<Self>;
    /// The same id added on both sides.
    fn merge2(local: &Self, remote: &Self) -> Option<Self>;
}

fn sort_entries<T: Entry>(entries: &mut [T]) {
    entries.sort_by(|a, b| a.order().cmp(b.order()).then_with(|| a.id().cmp(b.id())));
}

impl Entry for Item {
    fn id(&self) -> &str {
        &self.id
    }
    fn order(&self) -> &str {
        &self.order
    }
    fn edited(&self, base: &Self) -> bool {
        self.text != base.text || self.checked != base.checked
    }
    fn merge3(base: &Self, local: &Self, remote: &Self) -> Option<Self> {
        Some(Self {
            id: remote.id.clone(),
            text: three(&base.text, &local.text, &remote.text)?,
            checked: three_or(
                &base.checked,
                &local.checked,
                &remote.checked,
                remote.checked,
            ),
            order: three_or(
                &base.order,
                &local.order,
                &remote.order,
                remote.order.clone(),
            ),
            extra: merge_extra(&base.extra, &local.extra, &remote.extra),
        })
    }
    fn merge2(local: &Self, remote: &Self) -> Option<Self> {
        (local.text == remote.text).then(|| remote.clone())
    }
}

impl Entry for Field {
    fn id(&self) -> &str {
        &self.id
    }
    fn order(&self) -> &str {
        &self.order
    }
    fn edited(&self, base: &Self) -> bool {
        self.label != base.label || self.value != base.value
    }
    fn merge3(base: &Self, local: &Self, remote: &Self) -> Option<Self> {
        Some(Self {
            id: remote.id.clone(),
            label: three(&base.label, &local.label, &remote.label)?,
            value: three(&base.value, &local.value, &remote.value)?,
            order: three_or(
                &base.order,
                &local.order,
                &remote.order,
                remote.order.clone(),
            ),
            extra: merge_extra(&base.extra, &local.extra, &remote.extra),
        })
    }
    fn merge2(local: &Self, remote: &Self) -> Option<Self> {
        (local.label == remote.label && local.value == remote.value).then(|| remote.clone())
    }
}

/// One-side rule: the side that changed wins; both changing differently is `None`.
pub(super) fn three<T: PartialEq + Clone>(base: &T, local: &T, remote: &T) -> Option<T> {
    if local == remote || local == base {
        Some(remote.clone())
    } else if remote == base {
        Some(local.clone())
    } else {
        None
    }
}

pub(super) fn three_or<T: PartialEq + Clone>(base: &T, local: &T, remote: &T, collision: T) -> T {
    three(base, local, remote).unwrap_or(collision)
}

/// Unknown keys merge with the one-side rule; a collision takes the server value.
pub(super) fn merge_extra(
    base: &Map<String, Value>,
    local: &Map<String, Value>,
    remote: &Map<String, Value>,
) -> Map<String, Value> {
    let keys: Vec<&String> = remote
        .keys()
        .chain(local.keys())
        .chain(base.keys())
        .collect();
    let mut merged = Map::new();
    for key in keys {
        if merged.contains_key(key) {
            continue;
        }
        let (b, l, r) = (base.get(key), local.get(key), remote.get(key));
        if let Some(value) = three_or(&b, &l, &r, r) {
            merged.insert(key.clone(), value.clone());
        }
    }
    merged
}

fn merge_entries<T: Entry>(base: &[T], local: &[T], remote: &[T]) -> Option<Vec<T>> {
    let index = |list: &[T]| -> HashMap<String, T> {
        list.iter()
            .map(|e| (e.id().to_owned(), e.clone()))
            .collect()
    };
    let (b, l, r) = (index(base), index(local), index(remote));
    let mut seen = HashSet::new();
    let ids: Vec<&str> = remote
        .iter()
        .chain(local)
        .chain(base)
        .map(|e| e.id())
        .filter(|id| seen.insert(*id))
        .collect();
    let mut merged = vec![];
    for id in ids {
        let entry = match (b.get(id), l.get(id), r.get(id)) {
            (Some(b), Some(l), Some(r)) => Some(T::merge3(b, l, r)?),
            // Deleted on one side: deletion wins unless the other side edited it.
            (Some(b), None, Some(r)) => r.edited(b).then(|| r.clone()),
            (Some(b), Some(l), None) => l.edited(b).then(|| l.clone()),
            (None, Some(l), Some(r)) => Some(T::merge2(l, r)?),
            (None, Some(l), None) => Some(l.clone()),
            (None, None, Some(r)) => Some(r.clone()),
            _ => None,
        };
        merged.extend(entry);
    }
    sort_entries(&mut merged);
    Some(merged)
}

/// Per label: added on either side is added; removed on either side (and present in
/// the base) is removed. Order: the server's labels, then local additions.
pub(super) fn merge_labels(base: &[String], local: &[String], remote: &[String]) -> Vec<String> {
    let keys = |list: &[String]| -> HashSet<String> { list.iter().map(|l| label_key(l)).collect() };
    let (b, l, r) = (keys(base), keys(local), keys(remote));
    let keep = |key: &String| {
        if b.contains(key) {
            l.contains(key) && r.contains(key)
        } else {
            l.contains(key) || r.contains(key)
        }
    };
    let mut seen = HashSet::new();
    remote
        .iter()
        .chain(local)
        .filter(|label| {
            let key = label_key(label);
            keep(&key) && seen.insert(key)
        })
        .cloned()
        .collect()
}

fn content_changed(side: &Content, base: &Content) -> bool {
    side.body != base.body
        || side.memo != base.memo
        || side.items != base.items
        || side.fields != base.fields
}

/// Three-way merge of decrypted payloads. `None` means an unresolvable collision (or an
/// unsupported schema), and the caller keeps both copies.
pub fn merge(base: &Content, local: &Content, remote: &Content) -> Option<Content> {
    if !(base.supported() && local.supported() && remote.supported()) {
        return None;
    }
    let (bk, lk, rk) = (base.kind(), local.kind(), remote.kind());
    if [bk, lk, rk].into_iter().any(ledger::is_ledger_kind) {
        return ledger::merge(base, local, remote);
    }
    let kind = three(&bk, &lk, &rk)?;
    // A type conversion rewrites the content; it cannot merge with a content edit.
    if (lk != bk && content_changed(remote, base)) || (rk != bk && content_changed(local, base)) {
        return None;
    }
    let empty_items = vec![];
    let empty_fields = vec![];
    let items = if kind == CHECKLIST {
        Some(merge_entries(
            base.items.as_ref().unwrap_or(&empty_items),
            local.items.as_ref().unwrap_or(&empty_items),
            remote.items.as_ref().unwrap_or(&empty_items),
        )?)
    } else {
        three_or(
            &base.items,
            &local.items,
            &remote.items,
            remote.items.clone(),
        )
    };
    let fields = if kind == SECRET {
        Some(merge_entries(
            base.fields.as_ref().unwrap_or(&empty_fields),
            local.fields.as_ref().unwrap_or(&empty_fields),
            remote.fields.as_ref().unwrap_or(&empty_fields),
        )?)
    } else {
        three_or(
            &base.fields,
            &local.fields,
            &remote.fields,
            remote.fields.clone(),
        )
    };
    let body = if kind == TEXT {
        three(&base.body, &local.body, &remote.body)?
    } else {
        String::new() // derived by normalize()
    };
    let mut merged = Content {
        schema: local.schema.max(remote.schema),
        kind: (kind != TEXT).then(|| kind.to_owned()),
        title: three(&base.title, &local.title, &remote.title)?,
        body,
        memo: three(&base.memo, &local.memo, &remote.memo)?,
        color: three_or(
            &base.color,
            &local.color,
            &remote.color,
            remote.color.clone(),
        ),
        labels: merge_labels(&base.labels, &local.labels, &remote.labels),
        items,
        fields,
        ledger: three_or(
            &base.ledger,
            &local.ledger,
            &remote.ledger,
            remote.ledger.clone(),
        ),
        month: three_or(
            &base.month,
            &local.month,
            &remote.month,
            remote.month.clone(),
        ),
        income: three_or(&base.income, &local.income, &remote.income, remote.income),
        income_day: three_or(
            &base.income_day,
            &local.income_day,
            &remote.income_day,
            remote.income_day,
        ),
        recurring: three_or(
            &base.recurring,
            &local.recurring,
            &remote.recurring,
            remote.recurring.clone(),
        ),
        planned: three_or(
            &base.planned,
            &local.planned,
            &remote.planned,
            remote.planned.clone(),
        ),
        entries: three_or(
            &base.entries,
            &local.entries,
            &remote.entries,
            remote.entries.clone(),
        ),
        pinned: three_or(&base.pinned, &local.pinned, &remote.pinned, remote.pinned),
        deleted: three_or(&base.deleted, &local.deleted, &remote.deleted, false),
        archived: three_or(&base.archived, &local.archived, &remote.archived, false),
        created_at: three_or(
            &base.created_at,
            &local.created_at,
            &remote.created_at,
            remote.created_at.clone(),
        ),
        updated_at: local.updated_at.clone().max(remote.updated_at.clone()),
        extra: merge_extra(&base.extra, &local.extra, &remote.extra),
    };
    merged.normalize();
    merged.validate().ok()?;
    Some(merged)
}

pub(super) fn one_line(text: &str) -> String {
    text.split(['\r', '\n'])
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// GFM task list in display order: open items, then the completed group.
pub fn checklist_fallback(items: &[Item]) -> String {
    let mut sorted: Vec<&Item> = items.iter().collect();
    sorted.sort_by(|a, b| (a.checked, &a.order, &a.id).cmp(&(b.checked, &b.order, &b.id)));
    sorted
        .iter()
        .map(|i| {
            format!(
                "- [{}] {}",
                if i.checked { "x" } else { " " },
                one_line(&i.text)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `label: value` lines, then the free text after a blank line.
pub fn secret_fallback(fields: &[Field], memo: &str) -> String {
    let mut sorted: Vec<&Field> = fields.iter().collect();
    sorted.sort_by(|a, b| (&a.order, &a.id).cmp(&(&b.order, &b.id)));
    let mut text = sorted
        .iter()
        .map(|f| format!("{}: {}", one_line(&f.label), one_line(&f.value)))
        .collect::<Vec<_>>()
        .join("\n");
    if !memo.is_empty() {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(memo);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    fn fixture(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/fixtures/notes-v2")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[derive(Deserialize)]
    struct Vector {
        name: String,
        base: Value,
        local: Value,
        remote: Value,
        expected: Value,
    }

    #[test]
    fn shared_merge_vectors() {
        let file = fixture("merge-vectors.json");
        let vectors: Vec<Vector> = serde_json::from_value(file["vectors"].clone()).unwrap();
        assert!(vectors.len() >= 15);
        for v in vectors {
            let parse =
                |value: &Value| -> Content { serde_json::from_value(value.clone()).unwrap() };
            let result = merge(&parse(&v.base), &parse(&v.local), &parse(&v.remote));
            if v.expected.get("conflict") == Some(&Value::Bool(true)) {
                assert!(result.is_none(), "{}: expected a collision", v.name);
            } else {
                let result = result.unwrap_or_else(|| panic!("{}: unexpected collision", v.name));
                assert_eq!(
                    serde_json::to_value(&result).unwrap(),
                    v.expected,
                    "{}",
                    v.name
                );
            }
        }
    }

    #[test]
    fn shared_payload_examples_roundtrip_fallback_and_guard() {
        let file = fixture("payload-examples.json");
        for example in file["examples"].as_array().unwrap() {
            let name = example["name"].as_str().unwrap();
            let payload = &example["payload"];
            let content: Content = serde_json::from_value(payload.clone()).unwrap();
            // Unknown fields and the exact shape survive a read/write cycle.
            assert_eq!(serde_json::to_value(&content).unwrap(), *payload, "{name}");
            assert_eq!(
                content.supported(),
                example["supported"].as_bool().unwrap(),
                "{name}"
            );
            if content.supported() {
                let mut normalized = content.clone();
                normalized.normalize();
                assert_eq!(normalized.body, content.body, "{name}: fallback body");
                assert_eq!(
                    content.validate().is_ok(),
                    example["valid"].as_bool().unwrap(),
                    "{name}"
                );
            }
        }
    }

    #[test]
    fn v1_note_keeps_its_exact_shape() {
        let v1 = r#"{"title":"메모","body":"PC와 모바일","pinned":false,"deleted":false,"createdAt":"a","updatedAt":"b"}"#;
        let mut content: Content = serde_json::from_str(v1).unwrap();
        content.normalize();
        assert_eq!(serde_json::to_string(&content).unwrap(), v1);
    }

    fn item(id: &str, order: &str) -> Item {
        Item {
            id: id.into(),
            text: "x".repeat(10),
            checked: false,
            order: order.into(),
            extra: Map::new(),
        }
    }

    #[test]
    fn limits_are_enforced() {
        let mut c = Content::new("now");
        c.kind = Some(CHECKLIST.into());
        c.items = Some(
            (0..=MAX_ITEMS)
                .map(|i| item(&format!("i{i}"), &format!("a{i}")))
                .collect(),
        );
        c.normalize();
        assert!(c.validate().is_err());
        c.items = Some(vec![Item {
            text: "가".repeat(MAX_ITEM_CHARS + 1),
            ..item("a", "a")
        }]);
        assert!(c.validate().is_err());
        c.items = Some(vec![item("a", "a"), item("a", "b")]);
        assert!(c.validate().is_err(), "duplicate ids");
        c.items = Some(vec![item("a", "")]);
        assert!(c.validate().is_err(), "empty order");
        c.items = Some(vec![item("a", "a")]);
        assert!(c.validate().is_ok());
        c.labels = (0..=MAX_LABELS).map(|i| format!("l{i}")).collect();
        assert!(c.validate().is_err());
        c.labels = vec!["Work".into(), "work".into()];
        assert!(c.validate().is_err(), "case-insensitive duplicate");
        c.labels = vec!["가".repeat(MAX_LABEL_CHARS + 1)];
        assert!(c.validate().is_err());
        c.labels = vec![" padded".into()];
        assert!(c.validate().is_err());
        c.labels = vec!["업무".into()];
        c.color = Some("Amber!".into());
        assert!(c.validate().is_err());
        c.color = Some("amber".into());
        assert!(c.validate().is_ok());
        let mut s = Content::new("now");
        s.kind = Some(SECRET.into());
        s.fields = Some(vec![Field {
            id: "f".into(),
            label: "pw".into(),
            value: "v".repeat(MAX_FIELD_VALUE_CHARS + 1),
            order: "a".into(),
            extra: Map::new(),
        }]);
        assert!(s.validate().is_err());
        let mut big = Content::new("now");
        big.body = "a".repeat(MAX_BODY_BYTES);
        big.memo = Some("b".repeat(MAX_BODY_BYTES));
        assert!(big.validate().is_err(), "plaintext over 256 KiB");
        big.memo = None;
        big.title = "t".repeat(MAX_TITLE_CHARS + 1);
        assert!(big.validate().is_err());
    }

    #[test]
    fn fallback_bodies_are_readable_by_pre_v2_clients() {
        let mut c = Content::new("now");
        c.kind = Some(CHECKLIST.into());
        c.items = Some(vec![
            Item {
                checked: true,
                text: "done".into(),
                ..item("b", "a")
            },
            Item {
                text: "two\nlines".into(),
                ..item("c", "c")
            },
            Item {
                text: "first".into(),
                ..item("a", "b")
            },
        ]);
        c.normalize();
        assert_eq!(c.body, "- [ ] first\n- [ ] two lines\n- [x] done");
        assert_eq!(c.schema, Some(2));
        let mut s = Content::new("now");
        s.kind = Some(SECRET.into());
        s.memo = Some("참고".into());
        s.fields = Some(vec![Field {
            id: "f".into(),
            label: "API 키".into(),
            value: "abc".into(),
            order: "a".into(),
            extra: Map::new(),
        }]);
        s.normalize();
        assert_eq!(s.body, "API 키: abc\n\n참고");
    }
}
