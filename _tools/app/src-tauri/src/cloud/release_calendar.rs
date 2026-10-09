//! Calendar routes use the device API credential, never provider credentials.
use super::{bearer, read_json_bounded, CloudClient};
use crate::library::error::LibraryError;
use serde_json::{json, Value};

pub(crate) enum CalendarRun {
    Queued,
    Unavailable,
    RateLimited(Option<u64>),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn server_release_calendar_http_revalidates_etag_and_allows_response_envelope_over_eight_mib() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for conditional in [false, true] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    headers.push(byte[0]);
                }
                let headers = String::from_utf8(headers).unwrap().to_ascii_lowercase();
                assert!(headers.contains("authorization: bearer fixture-token"));
                if conditional {
                    assert!(headers.contains("if-none-match: \"fixture-etag\""));
                    stream.write_all(b"HTTP/1.1 304 Not Modified\r\nConnection: close\r\nETag: \"fixture-etag\"\r\n\r\n").unwrap();
                } else {
                    let body =
                        json!({"version":1,"metadata":"x".repeat(8 * 1024 * 1024)}).to_string();
                    write!(stream, "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nETag: \"fixture-etag\"\r\nContent-Length: {}\r\n\r\n{}", body.len(), body).unwrap();
                }
            }
        });
        let client = CloudClient::new(&url).unwrap();
        let (value, etag) = client
            .calendar_read_conditional("/v1/home/upcoming", "fixture-token", None)
            .unwrap()
            .unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(etag.as_deref(), Some("\"fixture-etag\""));
        assert!(client
            .calendar_read_conditional("/v1/home/upcoming", "fixture-token", etag.as_deref())
            .unwrap()
            .is_none());
        server.join().unwrap();
    }
}

impl CloudClient {
    pub(crate) fn calendar_read(&self, path: &str, token: &str) -> Result<Value, LibraryError> {
        self.calendar_read_conditional(path, token, None)?
            .map(|(value, _)| value)
            .ok_or(LibraryError::InvalidCloudResponse)
    }

    pub(crate) fn calendar_read_conditional(
        &self,
        path: &str,
        token: &str,
        etag: Option<&str>,
    ) -> Result<Option<(Value, Option<String>)>, LibraryError> {
        let mut request = self
            .coded_agent()?
            .get(self.endpoint(path)?)
            .header("Authorization", bearer(token)?);
        if let Some(etag) = etag {
            request = request.header("If-None-Match", etag);
        }
        let mut response = request
            .call()
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        match response.status().as_u16() {
            200 => {
                let etag = response
                    .headers()
                    .get("etag")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                // The response adds metadata/pending intents around the 8 MiB document.
                Ok(Some((
                    read_json_bounded(&mut response, 9 * 1024 * 1024)?,
                    etag,
                )))
            }
            304 if etag.is_some() => Ok(None),
            401 | 403 => Err(LibraryError::CloudUnauthorized),
            _ => Err(LibraryError::CloudRequestUnavailable),
        }
    }

    pub(crate) fn calendar_run(&self, token: &str) -> Result<CalendarRun, LibraryError> {
        let _permit = self.send_permit()?;
        let mut response = self
            .coded_agent()?
            .post(self.endpoint("/v1/home/upcoming/calendar/run")?)
            .header("Authorization", bearer(token)?)
            .send_json(&json!({"version":1}))
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        match response.status().as_u16() {
            200 => {
                let reply: Value = read_json_bounded(&mut response, 64 * 1024)?;
                if reply["version"] != 1 || reply["queued"] != true {
                    return Err(LibraryError::InvalidCloudResponse);
                }
                Ok(CalendarRun::Queued)
            }
            404 | 503 => Ok(CalendarRun::Unavailable),
            429 => Ok(CalendarRun::RateLimited(
                response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.trim().parse().ok()),
            )),
            401 | 403 => Err(LibraryError::CloudUnauthorized),
            _ => Err(LibraryError::CloudRequestUnavailable),
        }
    }
}
