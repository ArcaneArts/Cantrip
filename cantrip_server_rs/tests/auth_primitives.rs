use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_server::{
    auth::{
        cookie::{CookiePolicy, cookie_value},
        crypto::{self, PasswordService},
        rate_limit::AuthRateLimiter,
        validation,
    },
    config::{Environment, SameSite, ServerConfig},
};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};

fn oracle(requests: &Value) -> Result<Vec<Value>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let mut child = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/auth-crypto-oracle.mjs",
        ])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(requests)?)?;
    let output = child.wait_with_output()?;
    anyhow::ensure!(
        output.status.success(),
        "Node auth oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[tokio::test]
async fn password_hashes_work_in_both_runtimes() -> Result<()> {
    let passwords = [
        "isolated fixture password",
        "  synthetic 🦀 password  ",
        "synthetic\0password",
    ];
    let expected = oracle(&json!(
        passwords
            .iter()
            .map(|password| json!({"operation":"hash","password":password}))
            .collect::<Vec<_>>()
    ))?;
    let service = PasswordService::default();
    let mut reverse = Vec::new();
    for (password, hash) in passwords.iter().zip(expected) {
        assert!(
            service
                .verify(
                    hash.as_str().context("Node encoded password")?.into(),
                    password.to_string()
                )
                .await
        );
        assert!(
            !service
                .verify(hash.as_str().unwrap().into(), format!("{password}-wrong"))
                .await
        );
        let hash = service.hash(password.to_string()).await?;
        assert!(hash.starts_with("$argon2id$v=19$m=65536,t=3,p=1$"));
        reverse.push(json!({"operation":"verify","hash":hash,"password":password}));
        reverse
            .push(json!({"operation":"verify","hash":hash,"password":format!("{password}-wrong")}));
    }
    assert_eq!(
        oracle(&json!(reverse))?,
        vec![
            json!(true),
            json!(false),
            json!(true),
            json!(false),
            json!(true),
            json!(false)
        ]
    );
    assert!(!service.verify("malformed".into(), "synthetic".into()).await);
    Ok(())
}

#[test]
fn secret_normalization_and_rate_limiting_match_node() -> Result<()> {
    let values = [
        "",
        " fixture@EXAMPLE.invalid ",
        "\u{feff}ＦＯＯ@ＥＸＡＭＰＬＥ.invalid\u{feff}",
        "ΟΣ@Example.invalid",
        "İ@EXAMPLE.invalid",
        "\u{0085}value\u{0085}",
        "🦀\0private",
    ];
    let requests: Vec<_> = values
        .iter()
        .flat_map(|value| {
            [
                json!({"operation":"secret","value":value,"expected":value}),
                json!({"operation":"secret","value":value,"expected":"different"}),
            ]
        })
        .collect();
    let expected = oracle(&json!(requests))?;
    for (request, expected) in requests.iter().zip(expected) {
        let value = request["value"].as_str().unwrap();
        assert_eq!(
            json!({"hash":crypto::hash_secret(value),"email":crypto::normalize_email(value),"match":crypto::safe_secret_match(value,request["expected"].as_str().unwrap())}),
            expected
        );
    }
    let mut attempts = vec![
        json!({"key":"a","now":1000}),
        json!({"key":"a","now":1000}),
        json!({"key":"a","now":1001}),
        json!({"key":"a","now":61000}),
    ];
    attempts.extend((0..10300).map(|i| json!({"key":format!("fixture-{i}"),"now":62000})));
    attempts.extend([
        json!({"key":"a","now":62000}),
        json!({"key":"fixture-0","now":62000}),
        json!({"key":"fixture-10299","now":62000}),
    ]);
    let expected = oracle(&json!([{"operation":"rate","limit":1,"attempts":attempts}]))?;
    let mut limiter = AuthRateLimiter::new(1);
    let actual: Vec<_> = attempts
        .iter()
        .map(|r| limiter.consume(r["key"].as_str().unwrap(), r["now"].as_i64().unwrap()))
        .collect();
    assert_eq!(json!(actual), expected[0]);
    Ok(())
}

#[test]
fn cookies_csrf_and_entropy_match_the_existing_service() -> Result<()> {
    let mut requests = Vec::new();
    for (secure, same_site) in [
        (false, "lax"),
        (true, "lax"),
        (true, "none"),
        (true, "strict"),
    ] {
        let name = if secure {
            "__Host-cantrip_session"
        } else {
            "cantrip_session"
        };
        for value in ["opaque-token", "a+b/= 🦀!~*'()", ""] {
            for header in [
                format!("other=x; {name}=a%2Bb%3Dc"),
                format!("{name}=%GG; {name}=later"),
                format!("{name}=%FF"),
                format!(
                    "{name}={}; __Host-cantrip_partitioned_session=second",
                    "a".repeat(513)
                ),
            ] {
                requests.push(json!({"operation":"cookie","config":{"cookieSecure":secure,"cookieSameSite":same_site,"sessionTtlSeconds":300},"value":value,"header":header,"maxAge":300}));
            }
        }
    }
    let expected = oracle(&json!(requests))?;
    for (request, expected) in requests.iter().zip(expected) {
        let mut config = ServerConfig::read(&Environment::new(), &std::env::current_dir()?)?;
        config.cookie_secure = request["config"]["cookieSecure"].as_bool().unwrap();
        config.cookie_same_site =
            serde_json::from_value::<SameSite>(request["config"]["cookieSameSite"].clone())?;
        config.session_ttl_seconds = 300;
        let policy = CookiePolicy::new(&config)?;
        let mut queried = Vec::new();
        for name in [Some(policy.name), policy.partitioned_name]
            .into_iter()
            .flatten()
        {
            if let Some(token) = cookie_value(request["header"].as_str(), name)
                .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 512)
            {
                queried.push(crypto::hash_secret(&token));
            }
        }
        assert_eq!(
            json!({"serialized":policy.headers(request["value"].as_str().unwrap(),300),"cleared":policy.clear(),"queried":queried}),
            expected
        );
    }
    let hash = crypto::hash_secret("csrf synthetic fixture");
    let requests: Vec<_> = [
        json!("csrf synthetic fixture"),
        json!("wrong"),
        json!(null),
        json!(42),
        json!("a".repeat(513)),
    ]
    .into_iter()
    .flat_map(|candidate| {
        [
            hash.clone(),
            hash.to_uppercase(),
            format!("{hash}odd"),
            String::new(),
        ]
        .into_iter()
        .map(move |hash| json!({"operation":"csrf","hash":hash,"candidate":candidate}))
    })
    .collect();
    for (request, expected) in requests.iter().zip(oracle(&json!(requests))?) {
        assert_eq!(
            json!(crypto::csrf_matches(
                request["hash"].as_str().unwrap(),
                &request["candidate"]
            )),
            expected
        );
    }
    let mut tokens = std::collections::HashSet::new();
    for _ in 0..8 {
        let session = crypto::session_secret()?;
        assert_eq!(URL_SAFE_NO_PAD.decode(&session.token)?.len(), 32);
        assert_eq!(session.token_hash, crypto::hash_secret(&session.token));
        assert_eq!(session.csrf_token, crypto::csrf_token(&session.token));
        assert_eq!(
            session.csrf_token_hash,
            crypto::hash_secret(&session.csrf_token)
        );
        assert!(tokens.insert(session.token));
        let mobile = crypto::mobile_code()?;
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(mobile.code.strip_prefix("ctms_").unwrap())?
                .len(),
            24
        );
        assert_eq!(mobile.code_hash, crypto::hash_secret(&mobile.code));
    }
    Ok(())
}

#[test]
fn request_validation_matches_the_actual_protocol_schemas() -> Result<()> {
    let mut requests = Vec::new();
    for kind in ["register", "login", "reauthenticate", "exchange"] {
        for body in [
            None,
            Some(json!(null)),
            Some(json!(false)),
            Some(json!(42)),
            Some(json!([])),
            Some(json!("fixture")),
            Some(json!({})),
        ] {
            let mut request = json!({"operation":"validate","kind":kind});
            if let Some(body) = body {
                request["body"] = body;
            }
            requests.push(request);
        }
        let valid = match kind {
            "register" => {
                json!({"displayName":"Fixture","email":"fixture@example.invalid","password":"fixture password"})
            }
            "login" => json!({"email":"fixture@example.invalid","password":"fixture password"}),
            "reauthenticate" => json!({"password":"fixture password"}),
            _ => json!({"code":format!("ctms_{}","a".repeat(32))}),
        };
        requests.push(json!({"operation":"validate","kind":kind,"body":valid}));
        for field in ["displayName", "email", "password", "code"] {
            for value in [
                json!(null),
                json!(true),
                json!([]),
                json!({}),
                json!({"length":serde_json::from_str::<Value>("1e999")?}),
                json!({"length":serde_json::from_str::<Value>("-1e999")?}),
                json!(42),
                json!(""),
                json!(" "),
                json!("\u{feff} \u{feff}"),
                json!("🦀"),
                json!("a".repeat(120)),
                json!("a".repeat(121)),
                json!("🦀".repeat(60)),
                json!("🦀".repeat(61)),
                json!("a".repeat(1024)),
                json!("a".repeat(1025)),
            ] {
                let mut body = valid.clone();
                body[field] = value;
                requests.push(json!({"operation":"validate","kind":kind,"body":body}));
            }
            let mut body = valid.clone();
            body.as_object_mut().unwrap().shift_remove(field);
            requests.push(json!({"operation":"validate","kind":kind,"body":body}));
        }
        for extras in [
            json!({"unknown":1}),
            json!({"z":1,"a":2,"12":3,"2":4}),
            json!({"line\nquote\"":true,"nul\0":null}),
        ] {
            let mut body = valid.clone();
            body.as_object_mut()
                .unwrap()
                .extend(extras.as_object().unwrap().clone());
            requests.push(json!({"operation":"validate","kind":kind,"body":body}));
        }
        for email in [
            ".a@example.invalid",
            "a..b@example.invalid",
            "a@example.invalid\n",
            "a@example.invalid\r\n",
            "a@example.invalid\u{2028}",
            "a@1.invalid",
            "a@-host.invalid",
            "a@host-.invalid",
            "a+tag@example.invalid",
            "a'b@example.invalid",
            "a@localhost",
            "a@host.c",
            " a@example.invalid",
            "ＦＯＯ@example.invalid",
        ] {
            let mut body = valid.clone();
            body["email"] = json!(email);
            requests.push(json!({"operation":"validate","kind":kind,"body":body}));
        }
        for code in [
            format!("ctms_{}", "a".repeat(32)),
            format!("ctms_{}\n", "a".repeat(32)),
            format!("ctms_{}", "_".repeat(32)),
            format!("ctms_{}", "a".repeat(31)),
            format!("ctms_{}", "a".repeat(33)),
            format!("ctms_{}", "🦀".repeat(8)),
        ] {
            let mut body = valid.clone();
            body["code"] = json!(code);
            requests.push(json!({"operation":"validate","kind":kind,"body":body}));
        }
    }
    let expected = oracle(&json!(requests))?;
    for (index, (request, expected)) in requests.iter().zip(expected).enumerate() {
        let body = request
            .get("body")
            .map(cantrip_server::wire::Value::from_serialize);
        let actual = match validation::validate(request["kind"].as_str().unwrap(), body.as_ref()) {
            Ok(value) => json!({"ok": value}),
            Err(cantrip_server::wire::ValidationError::Invalid(issues)) => {
                json!({"error": "Invalid request body", "issues": issues})
            }
            Err(cantrip_server::wire::ValidationError::Operation) => {
                anyhow::bail!("Unexpected validation operation failure in case {index}")
            }
        };
        assert_eq!(actual, expected, "case {index}: {request}");
    }
    println!("{} Node/Rust request-schema cases matched", requests.len());
    Ok(())
}
