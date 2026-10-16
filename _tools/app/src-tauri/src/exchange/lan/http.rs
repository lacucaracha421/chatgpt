//! Bounded HTTP/1 framing. One request per connection, then close.
use serde_json::{json, Value};
use std::io::{self, Read, Write};
pub(super) const LIMIT: usize = 16 * 1024;
#[derive(Debug)]
pub(super) struct Reply(pub u16, pub Value);
impl Reply {
    pub(super) fn error(status: u16, code: &str) -> Self {
        Self(status, json!({"error":code}))
    }
    pub(super) fn ok(value: Value) -> Self {
        Self(200, value)
    }
}
pub(super) struct Request {
    pub method: String,
    pub path: String,
    pub length: Option<u64>,
}
pub(super) fn head(reader: &mut impl Read) -> Result<Request, Reply> {
    let invalid = || Reply::error(422, "invalidRequest");
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        if bytes.len() >= LIMIT {
            return Err(Reply::error(431, "headersTooLarge"));
        }
        let mut byte = [0];
        reader.read_exact(&mut byte).map_err(|_| invalid())?;
        bytes.push(byte[0]);
    }
    let mut headers = [httparse::EMPTY_HEADER; 128];
    let mut req = httparse::Request::new(&mut headers);
    if !req.parse(&bytes).map_err(|_| invalid())?.is_complete() {
        return Err(invalid());
    }
    let mut length = None;
    for h in req.headers.iter() {
        if h.name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(invalid());
        }
        if h.name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err(invalid());
            }
            let raw = std::str::from_utf8(h.value).map_err(|_| invalid())?;
            if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid());
            }
            length = Some(raw.parse().map_err(|_| invalid())?);
        }
    }
    let method = req.method.ok_or_else(invalid)?.to_owned();
    if method == "PUT" && length.is_none() {
        return Err(Reply::error(411, "lengthRequired"));
    }
    if method != "PUT" && length.unwrap_or(0) > LIMIT as u64 {
        return Err(Reply::error(413, "bodyTooLarge"));
    }
    Ok(Request {
        method,
        path: req.path.ok_or_else(invalid)?.into(),
        length,
    })
}
pub(super) fn body<T: serde::de::DeserializeOwned>(
    reader: &mut impl Read,
    length: Option<u64>,
) -> Result<T, Reply> {
    let length = length.unwrap_or(0);
    if length > LIMIT as u64 {
        return Err(Reply::error(413, "bodyTooLarge"));
    }
    let mut bytes = vec![0; length as usize];
    reader
        .read_exact(&mut bytes)
        .map_err(|_| Reply::error(422, "invalidRequest"))?;
    serde_json::from_slice(&bytes).map_err(|_| Reply::error(422, "invalidRequest"))
}
pub(super) fn respond(writer: &mut impl Write, reply: Reply) -> io::Result<()> {
    let bytes = serde_json::to_vec(&reply.1)?;
    write!(writer, "HTTP/1.1 {} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.0, bytes.len())?;
    writer.write_all(&bytes)?;
    writer.flush()
}
