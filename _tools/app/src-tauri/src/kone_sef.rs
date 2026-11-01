//! The small SEF boundary used by kone. No response text belongs in errors.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Value {
    Null,
    Bool(bool),
    UInt(u64),
    Int(i64),
    Float(f64),
    Bytes(Vec<u8>),
    String(String),
    Array(Vec<Value>),
    Map(Vec<(Value, Value)>),
    Timestamp(i64, u32),
    Duration(i64),
    Uuid([u8; 16]),
    Union(String, Box<Value>),
}
impl Value {
    pub fn field(&self, key: u8) -> &Value {
        // The key's integer width is the server's choice, so only its number counts.
        if let Self::Map(entries) = self {
            entries
                .iter()
                .find(|(k, _)| {
                    matches!(k, Self::UInt(_) | Self::Int(_)) && k.number() == i64::from(key)
                })
                .map(|(_, v)| v)
                .unwrap_or(&Self::Null)
        } else {
            &Self::Null
        }
    }
    pub fn named(&self, key: &str) -> &Value {
        self.lookup(&Value::String(key.into()))
    }
    fn lookup(&self, key: &Value) -> &Value {
        if let Self::Map(entries) = self {
            entries
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v)
                .unwrap_or(&Self::Null)
        } else {
            &Self::Null
        }
    }
    pub fn text(&self) -> &str {
        if let Self::String(s) = self {
            s
        } else {
            ""
        }
    }
    pub fn number(&self) -> i64 {
        match self {
            Self::Int(n) => *n,
            Self::UInt(n) => *n as i64,
            _ => 0,
        }
    }
    pub fn items(&self) -> &[Value] {
        if let Self::Array(a) = self {
            a
        } else {
            &[]
        }
    }
    pub fn id(&self) -> Result<String, String> {
        if let Self::Uuid(b) = self {
            Ok(uuid_to_text(b))
        } else {
            Err("소미 응답 형식 오류".into())
        }
    }
}
const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
const BYTE_LIMIT: usize = 64 * 1024 * 1024;
const ELEMENT_LIMIT: usize = 131072;
fn invalid<T>() -> Result<T, String> {
    Err("소미 응답 형식 오류".into())
}
pub(crate) fn uuid_to_text(bytes: &[u8; 16]) -> String {
    let mut out = [b'a'; 22];
    for digit in 0..22 {
        let mut n = 0;
        for k in 0..6 {
            let bit = digit * 6 + k;
            if bit < 128 {
                n |= ((bytes[bit / 8] >> (bit % 8)) & 1) << k;
            }
        }
        out[21 - digit] = ALPHABET[n as usize];
    }
    String::from_utf8(out.to_vec()).expect("ASCII alphabet")
}
pub(crate) fn uuid_from_text(text: &str) -> Result<[u8; 16], String> {
    if text.len() != 22 {
        return invalid();
    }
    let mut out = [0; 16];
    for (digit, c) in text.bytes().rev().enumerate() {
        let n = ALPHABET
            .iter()
            .position(|x| *x == c)
            .ok_or("소미 ID 형식 오류")?;
        for k in 0..6 {
            let bit = digit * 6 + k;
            let v = ((n >> k) & 1) as u8;
            if bit < 128 {
                out[bit / 8] |= v << (bit % 8);
            } else if v != 0 {
                return invalid();
            }
        }
    }
    Ok(out)
}
pub(crate) fn length(mut n: usize) -> Vec<u8> {
    let mut out = vec![(n % 128) as u8];
    n /= 128;
    while n > 0 {
        n -= 1;
        out.insert(0, 128 + (n % 128) as u8);
        n /= 128;
    }
    out
}
#[derive(Clone)]
struct Descriptor(u8, Option<Box<Descriptor>>);
struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        let end = self.offset.checked_add(n).ok_or("소미 응답 형식 오류")?;
        let b = self.bytes.get(self.offset..end).ok_or("소미 응답 잘림")?;
        self.offset = end;
        Ok(b)
    }
    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn len(&mut self, limit: usize) -> Result<usize, String> {
        let b = self.byte()?;
        let mut n = (b & 127) as usize;
        if b >= 128 {
            n += 1;
            for i in 2..=5 {
                let b = self.byte()?;
                n = n
                    .checked_mul(128)
                    .and_then(|n| n.checked_add((b & 127) as usize))
                    .ok_or("소미 응답 형식 오류")?;
                if b < 128 {
                    break;
                }
                if i == 5 {
                    return invalid();
                }
                n += 1;
            }
        }
        if n > limit {
            return invalid();
        }
        Ok(n)
    }
    fn descriptor(&mut self, depth: usize) -> Result<Descriptor, String> {
        if depth > 32 {
            return invalid();
        }
        let t = self.byte()?;
        Ok(Descriptor(
            t,
            if matches!(t, 3 | 64) {
                Some(Box::new(self.descriptor(depth + 1)?))
            } else {
                None
            },
        ))
    }
    fn value(&mut self, depth: usize) -> Result<Value, String> {
        let d = self.descriptor(depth)?;
        if d.0 == 2 {
            return invalid();
        }
        self.payload(&d, depth)
    }
    fn payload(&mut self, d: &Descriptor, depth: usize) -> Result<Value, String> {
        if depth > 32 {
            return invalid();
        }
        Ok(match d.0 {
            2 => return self.value(depth),
            1 => match self.byte()? {
                0 => Value::Bool(false),
                1 => Value::Bool(true),
                _ => return invalid(),
            },
            3 => match self.byte()? {
                0 => Value::Null,
                1 => return self.payload(d.1.as_ref().unwrap(), depth),
                _ => return invalid(),
            },
            t @ (16..=19) => {
                let width = 1 << (t - 16);
                let mut b = [0; 8];
                b[..width].copy_from_slice(self.take(width)?);
                Value::UInt(u64::from_le_bytes(b))
            }
            t @ (24..=27) => {
                let width = 1 << (t - 24);
                let bytes = self.take(width)?;
                let mut b = if bytes[width - 1] & 128 != 0 {
                    [255; 8]
                } else {
                    [0; 8]
                };
                b[..width].copy_from_slice(bytes);
                Value::Int(i64::from_le_bytes(b))
            }
            32 => Value::Float(f32::from_le_bytes(self.take(4)?.try_into().unwrap()) as f64),
            33 => Value::Float(f64::from_le_bytes(self.take(8)?.try_into().unwrap())),
            48 | 49 => {
                let n = self.len(BYTE_LIMIT)?;
                let b = self.take(n)?.to_vec();
                if d.0 == 48 {
                    Value::Bytes(b)
                } else {
                    Value::String(String::from_utf8(b).map_err(|_| "소미 응답 형식 오류")?)
                }
            }
            64 => {
                let n = self.len(ELEMENT_LIMIT)?;
                let mut a = Vec::new();
                for _ in 0..n {
                    a.push(self.payload(d.1.as_ref().unwrap(), depth + 1)?);
                }
                Value::Array(a)
            }
            65 => {
                let n = self.len(ELEMENT_LIMIT)?;
                let mut a = Vec::new();
                for _ in 0..n {
                    a.push((self.value(depth + 1)?, self.value(depth + 1)?));
                }
                Value::Map(a)
            }
            66 => {
                let n = self.len(BYTE_LIMIT)?;
                let name =
                    String::from_utf8(self.take(n)?.to_vec()).map_err(|_| "소미 응답 형식 오류")?;
                Value::Union(name, Box::new(self.value(depth + 1)?))
            }
            192 => Value::Timestamp(
                i64::from_le_bytes(self.take(8)?.try_into().unwrap()),
                u32::from_le_bytes(self.take(4)?.try_into().unwrap()),
            ),
            193 => Value::Duration(i64::from_le_bytes(self.take(8)?.try_into().unwrap())),
            194 => Value::Uuid(self.take(16)?.try_into().unwrap()),
            _ => return invalid(),
        })
    }
}
pub(crate) fn decode(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > BYTE_LIMIT {
        return invalid();
    }
    let mut r = Reader { bytes, offset: 0 };
    let v = r.value(0)?;
    if r.offset != bytes.len() {
        return invalid();
    }
    Ok(v)
}
/// Typed request fields retain their exact wire width and optional descriptor.
pub(crate) fn structure(mut fields: Vec<(u8, Vec<u8>)>) -> Vec<u8> {
    fields.sort_by_key(|f| f.0);
    let mut out = vec![65];
    out.extend(length(fields.len()));
    for (key, value) in fields {
        out.extend([16, key]);
        out.extend(value);
    }
    out
}
pub(crate) fn optional(descriptor: u8, value: Option<Vec<u8>>) -> Vec<u8> {
    let mut out = vec![3, descriptor, u8::from(value.is_some())];
    if let Some(value) = value {
        out.extend(value);
    }
    out
}
pub(crate) fn string_payload(s: &str) -> Vec<u8> {
    let mut out = length(s.len());
    out.extend(s.as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kone_vlq_boundaries_and_truncation() {
        for (n, wire) in [
            (127, vec![127]),
            (128, vec![128, 0]),
            (16511, vec![255, 127]),
            (16512, vec![128, 128, 0]),
        ] {
            assert_eq!(length(n), wire);
            let mut r = Reader {
                bytes: &wire,
                offset: 0,
            };
            assert_eq!(r.len(BYTE_LIMIT).unwrap(), n);
            let mut v = vec![49];
            v.extend(length(n));
            v.extend(vec![b'x'; n]);
            assert_eq!(decode(&v).unwrap().text().len(), n);
            v.pop();
            assert!(decode(&v).is_err());
        }
    }
    #[test]
    fn kone_handbuilt_vectors() {
        assert_eq!(
            decode(&[64, 3, 24, 3, 0, 1, 255, 1, 5]).unwrap(),
            Value::Array(vec![Value::Null, Value::Int(-1), Value::Int(5)])
        );
        let request = structure(vec![
            (1, vec![24, 255]),
            (0, optional(49, Some(string_payload("소미")))),
        ]);
        let v = decode(&request).unwrap();
        assert_eq!(v.field(0).text(), "소미");
        assert_eq!(v.field(1).number(), -1);
        assert!(decode(&[3, 64, 2, 1, 2, 49, 1]).is_err());
    }
    #[test]
    fn kone_id_roundtrip_matches_bit_order() {
        let mut b = [0; 16];
        b[0] = 1;
        assert_eq!(uuid_to_text(&b), "aaaaaaaaaaaaaaaaaaaaab");
        for s in ["dmXhWHD_fpPMT7WB-R3Pyb", "aaaaaaaaaaaaaaaaaaaaab"] {
            assert_eq!(uuid_to_text(&uuid_from_text(s).unwrap()), s);
        }
        assert!(uuid_from_text("zaaaaaaaaaaaaaaaaaaaaa").is_err());
        let mut wire = vec![194];
        wire.extend(b);
        assert_eq!(decode(&wire).unwrap(), Value::Uuid(b));
    }
}
