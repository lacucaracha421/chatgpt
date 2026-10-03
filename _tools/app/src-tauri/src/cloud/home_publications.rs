//! HTTP boundary for the PC-owned Home snapshots. Uses only publisher credentials.
use super::{bearer, map_registration_error, read_json_bounded, CloudClient};
use crate::cloud::collections::ArtworkBlob;
use crate::library::{error::LibraryError, home_publications::HomeTransport};
use serde_json::Value;

impl HomeTransport for CloudClient {
    fn publish(
        &self,
        path: &str,
        body: Option<&Value>,
        token: &str,
    ) -> Result<Value, LibraryError> {
        let _send = self.send_permit()?;
        let mut response = if let Some(body) = body {
            let bytes = serde_json::to_vec(body).map_err(|_| LibraryError::InvalidCloudResponse)?;
            let limit = match path {
                "/v1/home/upcoming" => 8 * 1024 * 1024,
                "/v1/library/artists" => 16 * 1024 * 1024,
                "/v1/library/auto-tags" => 1024 * 1024,
                "/v1/home/av-pick" => 64 * 1024,
                _ => return Err(LibraryError::InvalidCloudResponse),
            };
            if bytes.len() > limit {
                return Err(LibraryError::InvalidCloudResponse);
            }
            self.agent
                .put(self.endpoint(path)?)
                .header("Authorization", bearer(token)?)
                .content_type("application/json")
                .send(&bytes)
                .map_err(map_registration_error)?
        } else {
            if path != "/v1/home/av-pick" {
                return Err(LibraryError::InvalidCloudResponse);
            }
            self.agent
                .delete(self.endpoint(path)?)
                .header("Authorization", bearer(token)?)
                .call()
                .map_err(map_registration_error)?
        };
        read_json_bounded(&mut response, 64 * 1024)
    }

    fn intents(&self, after: i64, token: &str) -> Result<Value, LibraryError> {
        let path = format!("/v1/home/upcoming/wishlist/intents?after={after}&limit=200");
        let mut response = self
            .agent
            .get(self.endpoint(&path)?)
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(map_registration_error)?;
        read_json_bounded(&mut response, 4 * 1024 * 1024)
    }

    fn artwork(&self, blob: &ArtworkBlob, bytes: &[u8], token: &str) -> Result<(), LibraryError> {
        // This includes the second prepare/HEAD receipt after a signed upload.
        self.upload_collection_artwork(blob, bytes, token)
            .map(|_| ())
    }
}

#[cfg(test)]
mod fake_http {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };
    use ureq::unversioned::transport::{
        Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, Transport,
    };
    type Requests = Arc<Mutex<Vec<Vec<u8>>>>;
    #[derive(Debug)]
    struct MemoryConnector {
        replies: Mutex<VecDeque<Value>>,
        requests: Requests,
    }
    impl Connector for MemoryConnector {
        type Out = MemoryTransport;
        fn connect(
            &self,
            _: &ConnectionDetails,
            _: Option<()>,
        ) -> Result<Option<Self::Out>, ureq::Error> {
            let reply = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected HTTP request")
                .to_string();
            let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",reply.len()).into_bytes();
            let mut requests = self.requests.lock().unwrap();
            let index = requests.len();
            requests.push(vec![]);
            Ok(Some(MemoryTransport {
                buffers: LazyBuffers::new(4096, 4096),
                response: std::io::Cursor::new(response),
                requests: self.requests.clone(),
                index,
            }))
        }
    }
    #[derive(Debug)]
    struct MemoryTransport {
        buffers: LazyBuffers,
        response: std::io::Cursor<Vec<u8>>,
        requests: Requests,
        index: usize,
    }
    impl Transport for MemoryTransport {
        fn buffers(&mut self) -> &mut dyn Buffers {
            &mut self.buffers
        }
        fn transmit_output(&mut self, amount: usize, _: NextTimeout) -> Result<(), ureq::Error> {
            self.requests.lock().unwrap()[self.index]
                .extend_from_slice(&self.buffers.output()[..amount]);
            Ok(())
        }
        fn await_input(&mut self, _: NextTimeout) -> Result<bool, ureq::Error> {
            use std::io::Read;
            let n = self.response.read(self.buffers.input_append_buf()).unwrap();
            self.buffers.input_appended(n);
            Ok(n > 0)
        }
        fn is_open(&mut self) -> bool {
            false
        }
    }
    impl CloudClient {
        /// Exercise real HTTP serialization/auth without DNS, sockets or a running server.
        pub(crate) fn home_test_client(replies: Vec<Value>) -> (Self, Requests) {
            let requests = Requests::default();
            let connector = MemoryConnector {
                replies: Mutex::new(replies.into()),
                requests: requests.clone(),
            };
            let mut client = Self::new("http://127.0.0.1").unwrap();
            client.agent = ureq::Agent::with_parts(
                ureq::Agent::config_builder().proxy(None).http_status_as_error(false).max_redirects(0).build(),
                connector,
                ureq::unversioned::resolver::DefaultResolver::default(),
            );
            client.test_transport = Some(client.agent.clone());
            (client, requests)
        }
    }
}
