# TestFlight feedback imports

TestFlight beta feedback is collected through the App Store Connect API by the
manual `Collect TestFlight beta feedback` workflow. It reuses the
`APPSTORE_CONNECT_ISSUER_ID`, `APPSTORE_CONNECT_KEY_ID`, and
`APPSTORE_CONNECT_KEY` Actions secrets used by the native release. The workflow
accepts an ephemeral recipient certificate and uploads only a CMS-encrypted
archive; the API key, plaintext manifest, screenshots, and crash logs are
removed from the runner before artifact upload.

Treat the decrypted archive as private input. Review each screenshot and
comment for personal information, credentials, private conversations, and
other sensitive material before publishing anything to this public repository.
Do not commit the collected manifest, expiring Apple URLs, tester identity,
email addresses, or unreviewed crash logs.

Create issues in batches of at most four. Before each batch, search both open
and closed issues for the stable marker generated for every report:

```text
<!-- testflight-feedback-id: screenshot:<app-store-connect-id> -->
<!-- testflight-feedback-id: crash:<app-store-connect-id> -->
```

Include exactly one marker at the end of its corresponding issue. The marker
is the durable import ledger: a later import skips every report whose marker
already appears in any issue body. Reviewed screenshots may be committed under
this directory in a report-ID-named folder and embedded in the issue. Crash
logs must remain private unless they have been explicitly inspected and
redacted for public disclosure.
