"""Tablet kept-link previews (parity U02): public HTTPS only, cached, the PC's fields."""
import socket
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import link_preview

AUTH = {"Authorization": "Bearer client"}


def resolving(*addresses):
    rows = [(socket.AF_INET6 if ":" in a else socket.AF_INET, socket.SOCK_STREAM, 6, "", (a, 443)) for a in addresses]
    return mock.patch.object(link_preview.socket, "getaddrinfo", return_value=rows)


class AddressTests(unittest.TestCase):
    def test_internal_and_tailnet_addresses_are_refused_after_resolution(self):
        for address in ("127.0.0.1", "10.0.0.5", "192.168.1.2", "169.254.169.254", "100.76.119.29", "::1",
                        "::ffff:127.0.0.1", "fd00::1"):
            with self.subTest(address=address), resolving("93.184.216.34", address):
                with self.assertRaises(link_preview.PreviewRefused):
                    link_preview.public_addresses("example.org")
        with resolving("93.184.216.34"):
            self.assertEqual(link_preview.public_addresses("example.org"), {"93.184.216.34"})

    def test_only_https_on_the_default_port_without_credentials(self):
        for url in ("http://example.org/", "https://user:pw@example.org/", "https://example.org:8443/", "file:///etc/passwd",
                    "https:///nohost"):
            with self.subTest(url=url), self.assertRaises(link_preview.PreviewRefused):
                link_preview.check_url(url)
        self.assertEqual(link_preview.check_url("https://example.org/a#frag"), "https://example.org/a")


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.pages = {}

        def fetcher(url, accept, limit, deadline, referer=None):
            self.calls.append(url)
            page = self.pages.get(url)
            if page is None:
                raise link_preview.PreviewUnavailable()
            return url, page[0], page[1]

        def guard(value):
            if value != AUTH["Authorization"]:
                raise HTTPException(401)

        app = FastAPI()
        link_preview.register(app, guard, fetcher)
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()

    def post(self, url, headers=AUTH):
        return self.client.post(link_preview.ROUTE, headers=headers, json={"url": url})

    def test_open_graph_preview_is_read_once_and_cached(self):
        self.pages["https://example.org/post"] = ("text/html; charset=euc-kr", (
            "<html><head><title>문서</title><meta property='og:title' content='제목 &amp; 부제'>"
            "<meta property='og:site_name' content='예제'><meta property='og:image' content='/cover.jpg'>"
            "</head></html>").encode("euc-kr"))
        first = self.post("https://example.org/post")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json(), {"title": "제목 & 부제", "siteName": "예제", "imageUrl": "https://example.org/cover.jpg"})
        self.assertEqual(self.post("https://example.org/post").json(), first.json())
        self.assertEqual(self.calls, ["https://example.org/post"])

    def test_x_links_use_the_public_oembed_fallback(self):
        self.pages["https://x.com/someone/status/123"] = ("text/html", b"<title>X</title>")
        oembed = link_preview._fallback("https://x.com/someone/status/123")[1]
        self.pages[oembed] = ("application/json", b'{"author_name":"Someone","html":"<blockquote><p>hello<br>world</p></blockquote>"}')
        self.assertEqual(self.post("https://x.com/someone/status/123").json(),
                         {"title": "Someone: hello world", "siteName": "X", "imageUrl": None})

    def test_refusals_failures_and_auth(self):
        self.assertEqual(self.post("http://example.org/").status_code, 422)
        self.assertEqual(self.post("https://missing.example/").status_code, 502)
        self.assertEqual(self.post("https://example.org/", headers={}).status_code, 401)
        self.assertEqual(self.client.post(link_preview.ROUTE, headers=AUTH, json={"url": "https://a.example/", "more": 1}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
