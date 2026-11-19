#!/usr/bin/env node
"use strict";

// Mock of the AWS VPN Client local auth environment for testing
// VPN Tab Reaper. No dependencies — plain node http.
//
//   127.0.0.1:35001  — the VPN client's local SAML listener. Any GET/POST
//                      returns the "Authentication successful" page, exactly
//                      the page the real client leaves open.
//   127.0.0.1:4545   — a mock IdP:
//                        /auto   → valid session: auto-POSTs a (fake) SAML
//                                  assertion straight to :35001
//                        /login  → expired session: shows a sign-in form;
//                                  submitting auto-POSTs to :35001

const http = require("http");

const SAML_RESPONSE = "PHNhbWw+ZmFrZS1hc3NlcnRpb24tZnJvbS1tb2NrLWlkcDwvc2FtbD4=";

const successPage = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>AWS VPN Client | Authentication</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
           justify-content: center; height: 100vh; margin: 0; background: #fff; }
    .box { text-align: center; }
    .mark { width: 84px; height: 84px; border-radius: 50%; background: #2e7d32;
            color: #fff; font-size: 44px; line-height: 84px; margin: 0 auto 18px; }
    h1 { font-size: 24px; margin: 8px 0; }
    p { color: #545b64; }
    .brand { color: #232f3e; font-weight: 700; letter-spacing: .5px; margin-top: 26px; }
  </style>
</head>
<body>
  <div class="box">
    <div class="brand">AWS</div>
    <div class="brand" style="margin-top:2px">VPN Client</div>
    <div style="height:26px"></div>
    <div class="mark">&#10003;</div>
    <h1>Authentication successful</h1>
    <p>You may now close this browser tab.</p>
  </div>
</body>
</html>`;

function autoPostPage(nextUrl) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Signing you in…</title></head>
<body onload="document.forms[0].submit()">
  <p>Redirecting to AWS VPN Client…</p>
  <form method="POST" action="${nextUrl}">
    <input type="hidden" name="SAMLResponse" value="${SAML_RESPONSE}">
    <input type="hidden" name="RelayState" value="">
  </form>
</body>
</html>`;
}

const loginPage = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Sign in</title>
<style>
  body { font-family: -apple-system, sans-serif; display:flex; align-items:center;
         justify-content:center; height:100vh; margin:0; }
  .card { border:1px solid #ddd; border-radius:10px; padding:28px 34px; text-align:center; }
  input { display:block; margin:8px auto; padding:8px; width:220px; }
  button { padding:9px 22px; margin-top:10px; }
</style></head>
<body>
  <div class="card">
    <h2>Mock IdP — Sign in</h2>
    <form method="POST" action="/login">
      <input name="username" placeholder="username" value="testuser">
      <input name="password" type="password" placeholder="password" value="hunter2">
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;

// --- The VPN client's local listener (:35001) -------------------------------

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const gotSaml = /SAMLResponse/.test(body);
      console.log(
        `[35001] ${req.method} ${req.url} — SAML assertion ${gotSaml ? "DELIVERED ✓" : "absent"}`
      );
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(successPage);
    });
  })
  .listen(35001, "127.0.0.1", () =>
    console.log("mock AWS VPN local auth listener: http://127.0.0.1:35001")
  );

// --- Mock IdP (:4545) --------------------------------------------------------

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url.split("?")[0];
      console.log(`[4545]  ${req.method} ${url}`);

      if (url === "/auto") {
        // Valid IdP session: instantly POST the assertion to the VPN client.
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(autoPostPage("http://127.0.0.1:35001/"));
      } else if (url === "/login" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(loginPage);
      } else if (url === "/login" && req.method === "POST") {
        // "Authenticated" — now hand off to the VPN client.
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(autoPostPage("http://127.0.0.1:35001/"));
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found — try /auto or /login");
      }
    });
  })
  .listen(4545, "127.0.0.1", () =>
    console.log("mock IdP: http://127.0.0.1:4545/auto (session valid) | /login (interactive)")
  );
