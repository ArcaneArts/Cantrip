use anyhow::{Context, Result, ensure};
use cantrip_server::{config::Environment, env_file};
use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};

#[test]
fn dotenv_values_match_the_existing_node_file_loader() -> Result<()> {
    let mut cases = vec![
        String::new(),
        "# comment\r\n".into(),
        "A=\nB=tail".into(),
        "export A=one\nA=two\nexport B=\nC= three # ignored\n".into(),
        "=empty\nexport   =x\nignored line\nA=valid".into(),
        "A=\"line\\nsecond\"\nB='literal\\n'\nC=`雪 😀 # literal`\n".into(),
        "A='multi\nline'\nB=\"unterminated\nC=after".into(),
        "  # spaced comment\n A = literal $(echo bad) $HOME ; dangerous\n".into(),
        "CANTRIP_DOTENV_EXISTING=overwritten\nA=new\n".into(),
        "A=first\nA\0suffix=second\n".into(),
        "A\0suffix=first\nA=second\n".into(),
        "\0invalid=value\n=\nB=valid\n".into(),
    ];
    for key in [
        "A",
        "export A",
        "export   A",
        "",
        "雪",
        "__proto__",
        "constructor",
        "A B",
        "A\0suffix",
    ] {
        for value in [
            "",
            "plain",
            "a=b",
            "a #comment",
            "\"double\\nline\"",
            "'single\\nline'",
            "`backtick`",
            "\"no end",
            "'multi\nline'",
            "🧙 雪",
            "a\rb\r\nc",
            "\0value",
        ] {
            for separator in ["", " ", "\t"] {
                for suffix in ["", "\nZ=tail", "\r\nZ=tail", "\n # final"] {
                    cases.push(format!("{key}{separator}={separator}{value}{suffix}"));
                }
            }
        }
    }
    // Exercise the operation used by the old distribution launcher. util.parseEnv
    // converts to a normal JS object and drops __proto__; the actual file loader
    // correctly creates that process variable and also applies OS NUL rules.
    let script = r#"
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
let input=''; for await(const chunk of process.stdin) input+=chunk;
process.env.CANTRIP_DOTENV_EXISTING='preserved';
const baseline=Object.fromEntries(Object.entries(process.env));
const directory=mkdtempSync(join(tmpdir(),'cantrip-dotenv-oracle-'));
try {
 const results=JSON.parse(input).map(source=>{
  for(const key of Object.keys(process.env)) if(!Object.hasOwn(baseline,key)) delete process.env[key];
  for(const [key,value] of Object.entries(baseline)) process.env[key]=value;
  const file=join(directory,'.env'); writeFileSync(file,source);
  process.loadEnvFile(file);
  return {
   added:Object.fromEntries(Object.entries(process.env).filter(([key])=>!Object.hasOwn(baseline,key))),
   retained:process.env.CANTRIP_DOTENV_EXISTING
  };
 });
 process.stdout.write(JSON.stringify({baselineKeys:Object.keys(baseline),results}));
} finally { rmSync(directory,{recursive:true,force:true}); }
"#;
    let mut child = Command::new("node")
        .args(["--input-type=module", "--eval", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .context("oracle stdin")?
        .write_all(serde_json::to_string(&cases)?.as_bytes())?;
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success(),
        "Node dotenv oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout)?;
    let expected = oracle["results"]
        .as_array()
        .context("oracle result array")?;
    let mut baseline = Environment::new();
    for name in oracle["baselineKeys"]
        .as_array()
        .context("baseline key array")?
    {
        baseline.insert(
            name.as_str().context("baseline name")?.to_owned(),
            "preserved".into(),
        );
    }
    ensure!(
        expected.len() == cases.len(),
        "Incomplete actual oracle output"
    );
    for (index, (source, expected)) in cases.iter().zip(expected).enumerate() {
        let mut environment = baseline.clone();
        env_file::apply_to(&mut environment, source);
        let retained = environment.get("CANTRIP_DOTENV_EXISTING").cloned();
        environment.retain(|name, _| !baseline.contains_key(name));
        assert_eq!(
            json!({"added":environment,"retained":retained}),
            *expected,
            "dotenv case {index}: {source:?}"
        );
    }
    println!(
        "{} actual Node dotenv value comparisons matched",
        cases.len()
    );
    Ok(())
}
