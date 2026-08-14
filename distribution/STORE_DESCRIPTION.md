# Cantrip store listing metadata

This file is the source of truth for the English (U.S.) App Store and Google
Play listings. Text inside fenced blocks is ready to paste. Items marked
`TODO` require an operator, legal, or product decision before submission.

Store requirements and limits were verified against the official Apple and
Google documentation on August 14, 2026.

## Canonical product facts

| Field                      | Value                                     |
| -------------------------- | ----------------------------------------- |
| Product name               | Cantrip                                   |
| Bundle ID / application ID | `art.cantrip`                             |
| Primary locale             | English (U.S.) / `en-US`                  |
| Brand tagline              | One workspace for the whole build.        |
| Product type               | Self-hostable software-development client |
| Website                    | `https://cantrip.art`                     |
| Source                     | `https://github.com/ArcaneArts/Cantrip`   |

Cantrip mobile is not a standalone coding runtime. It connects to a reachable
Cantrip server, which routes project operations to enrolled worker machines.
Most project features require at least one online worker.

## Shared full description

This copy is below the 4,000-character limit used by both stores. Preserve the
plain-text line breaks; App Store descriptions do not support HTML.

```text
Cantrip keeps your software projects, coding agents, and development tools together wherever you work.

Connect the mobile app to your self-hosted Cantrip server to follow work in progress and reach the worker machines that hold your repositories. Move between structured agent conversations, live terminals, project files, Git history, browser sessions, and remote desktops without rebuilding context on each device.

WORK WITH CODING AGENTS
- Start, steer, queue, pause, and resume agent work
- Read structured responses, plans, tool activity, and subagent progress
- Attach files and continue durable conversations across devices

KEEP PROJECT TOOLS TOGETHER
- Use real worker-owned terminal sessions
- Browse files and preview supported source and Markdown
- Inspect branches, worktrees, commits, diffs, and working changes
- Open worker-hosted browser and remote desktop sessions

CONTROL YOUR OWN DEPLOYMENT
- Self-host the Cantrip server and enroll the machines that own your code
- Sign in on mobile with a short-lived QR handoff or your server credentials
- Keep source files and running development processes on your workers
- Route client traffic through your authenticated Cantrip server

Cantrip is open source and under active development.

REQUIREMENTS
Cantrip for mobile is a client for an existing Cantrip installation. A reachable Cantrip server and at least one enrolled worker are required for most project features. Coding workloads do not run directly on your phone or tablet.
```

## Suggested screenshot story

Use real app captures with sanitized demo data. Do not show access tokens,
private repository names, personal messages, or customer source code.

1. **Steer every coding agent** — project overview and an active structured chat.
2. **Real terminals, wherever you are** — a connected worker terminal.
3. **Review Git changes with context** — branch history, working changes, or a diff.
4. **Reach the tools on your worker** — a browser or remote desktop session.
5. **One workspace across devices** — the mobile project and tab navigation.

Optional feature-graphic tagline:

```text
Build from anywhere.
```

## Apple App Store

### Product-page copy

| Field              | Pasteable value                   | Limit / status                     |
| ------------------ | --------------------------------- | ---------------------------------- |
| Name               | `Cantrip`                         | 7 of 30 characters                 |
| Subtitle           | `Your build workspace, anywhere`  | 30 of 30 characters                |
| Promotional text   | See below                         | 161 of 170 characters; optional    |
| Description        | Use the shared full description   | Required; maximum 4,000 characters |
| Keywords           | See below                         | 95 of 100 bytes; required          |
| Support URL        | `TODO: public support page URL`   | Required                           |
| Marketing URL      | `https://cantrip.art`             | Optional                           |
| Privacy Policy URL | `TODO: public privacy policy URL` | Required                           |

Promotional text:

```text
Stay close to every build from your iPhone or iPad. Steer coding agents, follow terminals, review Git changes, and reach the worker machines that hold your code.
```

Keywords are comma-separated, contain no product or company names, and stay
within Apple's 100-byte limit:

```text
coding,developer,agent,terminal,git,workflow,remote,workspace,self-hosted,automation,repository
```

### App record and version information

| Field              | Recommended value / action                                                  |
| ------------------ | --------------------------------------------------------------------------- |
| Bundle ID          | `art.cantrip`                                                               |
| SKU                | `TODO: choose a stable internal SKU`, for example `cantrip-ios-001`         |
| Primary language   | English (U.S.)                                                              |
| Primary category   | Developer Tools (recommended; confirm in App Store Connect)                 |
| Secondary category | Productivity (recommended; optional)                                        |
| Copyright          | `TODO: current year and legal rights-holder name`                           |
| Price              | `TODO: choose price tier`; no in-app purchases are currently documented     |
| Availability       | `TODO: select countries/regions and preorder/release behavior`              |
| Version / build    | Must match the uploaded Xcode archive                                       |
| Release notes      | Required for updates; maintain separately for each version                  |
| Content rights     | Confirm the right to display all included and streamed third-party content  |
| License agreement  | Use Apple's standard EULA unless legal supplies a custom agreement          |
| DSA status         | Complete the trader/non-trader declaration in App Store Connect             |
| Export compliance  | Answer from the final binary and its HTTPS/cryptography usage; do not guess |

### Apple screenshots and review material

- Provide 1–10 screenshots for each required device class. Cantrip currently
  targets iPhone and iPad, so prepare both sets unless App Store Connect can
  scale the accepted highest-resolution set for the selected devices.
- App previews are optional; up to three may be supplied per supported device
  size and localization.
- Keep the review server, demo account, and at least one enrolled demo worker
  online for the entire review window.
- Provide reviewer contact name, email, and phone number.
- Attach additional setup documentation or a sample QR code if the reviewer
  cannot reach all functionality using the supplied credentials.

Suggested App Review notes:

```text
Cantrip is a client for a self-hosted software-development workspace. The submitted app does not execute coding workloads on the iPhone or iPad. It connects to the review server below, which routes operations to an enrolled demo worker.

Review server: TODO_REVIEW_SERVER_URL
Email: TODO_REVIEW_ACCOUNT_EMAIL
Password: TODO_REVIEW_ACCOUNT_PASSWORD

Review steps:
1. Launch Cantrip and open the server selector.
2. Add the review server URL shown above and select it.
3. Sign in with the supplied review account.
4. Open the preconfigured sample project. Its demo worker will remain online during review.
5. The camera permission is optional and is used only to scan a short-lived Cantrip sign-in QR code. The supplied email/password credentials do not require camera access.

The sample project contains synthetic data and is safe for reviewer changes.
```

### Apple submission declarations

- **App Privacy:** Audit the release client, server, worker, and every bundled
  third-party SDK. Declare all collected data, whether it is linked to the user,
  and each purpose. Likely review areas include account identity, user content
  (prompts, conversations, and attachments), identifiers, and diagnostics.
- **Privacy policy:** Publish an active policy covering Cantrip's client/server/
  worker data flow, retention, deletion, security, subprocesses, and a privacy
  contact. Link it in App Store Connect and make it reachable inside the app.
- **Age rating:** Complete the current questionnaire. Account for the terminal,
  worker-hosted browser, remote desktop, and other user-controlled content; do
  not assume the lowest rating merely because Cantrip supplies no editorial
  content.
- **Account deletion — submission blocker:** Cantrip supports account creation,
  but no in-app account-deletion flow was found during this metadata audit.
  Apple requires apps that support account creation to let users initiate full
  account deletion from within the app.
- **Review access:** Supply a stable demo account, reachable server, online
  worker, sample repository, and instructions for every non-obvious feature.
- **Camera:** The native usage description must continue to state that camera
  access is used to scan a Cantrip sign-in QR code. The app must remain usable
  through credential sign-in when camera access is declined.

## Google Play

### Main store listing copy

| Field             | Pasteable value                                                        | Limit / status                     |
| ----------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| App name          | `Cantrip`                                                              | 7 of 30 characters                 |
| Short description | See below                                                              | 77 of 80 characters; required      |
| Full description  | Use the shared full description                                        | Required; maximum 4,000 characters |
| App or game       | App                                                                    |
| Category          | Tools (recommended; confirm in Play Console)                           |
| Tags              | `TODO: choose only Play Console tags that accurately describe the app` |
| Support email     | `TODO: monitored public support email`                                 | Required and displayed publicly    |
| Website           | `https://cantrip.art`                                                  | Recommended                        |
| Privacy policy    | `TODO: public privacy policy URL`                                      | Required                           |

Short description:

```text
Coding agents, terminals, Git, and remote tools in one self-hosted workspace.
```

### Google Play graphic assets

- **Store icon:** 512×512 px, 32-bit PNG with alpha, no larger than 1,024 KB.
  This is separate from the launcher icons packaged in the Android app.
- **Feature graphic:** 1024×500 px JPEG or 24-bit PNG without alpha; required.
  Suggested copy: “Build from anywhere.”
- **Screenshots:** Provide at least two JPEG or 24-bit PNG screenshots without
  alpha. Each dimension must be 320–3,840 px, and the long dimension cannot be
  more than twice the short dimension.
- For stronger Play discovery, provide at least four phone screenshots at
  1080 px or greater in 9:16 portrait or 16:9 landscape format.
- Provide dedicated tablet screenshots if tablet distribution remains enabled.
  Google recommends four screenshots for each supported large-screen class.
- Add concise alt text for every graphic asset and screenshot.
- A preview video is optional. If supplied, it must be a public or unlisted
  YouTube video with monetization disabled.

### Google Play app content and review declarations

| Declaration                            | Required action                                                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| App access                             | Provide the review server URL, demo credentials, setup steps, and any QR/hardware information needed to reach restricted features |
| Ads                                    | Expected answer is **No** based on the current repository; confirm against the final build and all SDKs                           |
| Content rating                         | Complete the IARC questionnaire and account for user-controlled terminals, browsers, remote desktops, and agent output            |
| Target audience                        | Recommended starting point is adults / 18 and over; confirm with product and legal rather than targeting children accidentally    |
| Data safety                            | Audit collection, sharing, encryption in transit, optional data, and deletion against the final client/server/worker deployment   |
| Privacy policy                         | Publish an active HTML page, link it in Play Console and inside the app, and keep it consistent with Data Safety answers          |
| Account deletion                       | Implement an in-app deletion path and provide the required public web deletion URL before submission                              |
| Camera permission                      | Explain that camera access is optional and used only for QR sign-in; verify no QR image or camera frame leaves the device         |
| News / health / financial declarations | Expected answer is **No** for the current product; reconfirm in Play Console                                                      |
| Government / regulated functionality   | Expected answer is **No** for the current product; reconfirm before every release                                                 |

Use the same review account and infrastructure described in the Apple review
notes. Google permits multiple instruction sets; add a separate set only when a
feature requires different access.

## Pre-submission blockers and owner decisions

Do not submit either store build until these are resolved:

1. **Implement account deletion.** The current app exposes account registration,
   but this audit found no user-facing account deletion flow. Both stores require
   deletion support for apps that create accounts.
2. **Publish and link a privacy policy.** It must be public, app-specific,
   consistent with the store privacy declarations, and accessible from inside
   the app. Google requires a normal web page rather than a PDF.
3. **Create permanent support channels.** Supply a public support page, monitored
   support email, and the legal rights-holder/contact details used by both
   developer accounts.
4. **Audit data handling.** Inventory the release app, hosted server, workers,
   authentication, attachments, diagnostics, and all third-party SDKs before
   completing Apple App Privacy or Google Data Safety.
5. **Prepare review infrastructure.** Maintain a TLS-enabled review server, demo
   user, enrolled worker, synthetic repository, and written credentials for the
   duration of both reviews.
6. **Choose commercial and regional settings.** Confirm pricing, availability,
   legal entity, copyright, DSA status, export compliance, categories, audience,
   and age/content ratings.
7. **Produce store graphics.** Create the Google Play feature graphic and store
   icon plus sanitized iPhone, iPad, Android phone, and Android tablet captures.

## Official references

Apple:

- [App information fields and limits](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/)
- [Platform version information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information)
- [Required, localizable, and editable properties](https://developer.apple.com/help/app-store-connect/reference/app-information/required-localizable-and-editable-properties)
- [Screenshot and app preview requirements](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots)
- [App privacy setup](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/)
- [Age rating setup](https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating)
- [Account deletion requirement](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

Google:

- [Create and set up an app](https://support.google.com/googleplay/android-developer/answer/9859152?hl=en)
- [Preview asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en)
- [Store listing best practices](https://support.google.com/googleplay/android-developer/answer/13393723?hl=en)
- [Prepare an app for review](https://support.google.com/googleplay/android-developer/answer/9859455?hl=en)
- [User Data and privacy policy requirements](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en)
- [Data Safety requirements](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)
