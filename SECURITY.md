# Security Policy

## Reporting a Vulnerability

This project handles cryptographic key material and Lightning Network funds. Security issues are taken seriously.

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, email **johncantrell97@gmail.com** with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You should receive a response within 48 hours. If the issue is confirmed, a fix will be developed privately and released as soon as possible.

## Scope

Security-relevant areas include:

- BIP-39 mnemonic handling and key derivation
- Channel state persistence and crash recovery
- WASM boundary (Rust/JS FFI)
- Webhook authentication
- Network communication with LSP and Esplora

## Supported Versions

Only the latest release is supported with security updates.
