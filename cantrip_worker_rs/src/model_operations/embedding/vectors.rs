use super::{request::Adapter, *};
use base64::{
    Engine, alphabet,
    engine::{GeneralPurpose, GeneralPurposeConfig},
};
use cantrip_crypto::Zeroizing;

const MAX_DIMENSIONS: usize = 65_536;

fn invalid() -> anyhow::Error {
    error(
        "invalid-response",
        "The provider returned malformed embedding data.",
    )
}

fn finite(value: &Value) -> Result<f64> {
    value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(invalid)
}

fn dense(value: &Value) -> Result<(Vec<f64>, &'static str)> {
    if let Some(encoded) = value.as_str() {
        if encoded.len() > ((MAX_DIMENSIONS * 4).div_ceil(3) * 4) {
            return Err(invalid());
        }
        const STANDARD: GeneralPurpose = GeneralPurpose::new(
            &alphabet::STANDARD,
            GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
        );
        let bytes = Zeroizing::new(STANDARD.decode(encoded).map_err(|_| invalid())?);
        if bytes.is_empty() || bytes.len() % 4 != 0 || bytes.len() > MAX_DIMENSIONS * 4 {
            return Err(invalid());
        }
        let values = bytes
            .chunks_exact(4)
            .map(|bytes| f64::from(f32::from_le_bytes(bytes.try_into().unwrap())))
            .collect::<Vec<_>>();
        if values.iter().any(|value| !value.is_finite()) {
            return Err(invalid());
        }
        return Ok((values, "base64"));
    }
    let values = value
        .as_array()
        .filter(|values| (1..=MAX_DIMENSIONS).contains(&values.len()))
        .ok_or_else(invalid)?;
    Ok((values.iter().map(finite).collect::<Result<_>>()?, "float"))
}

fn normalize(mut values: Vec<f64>, options: &Value) -> Result<Vec<f64>> {
    if options["normalization"] != "l2" {
        return Ok(values);
    }
    let scale = values.iter().map(|value| value.abs()).fold(0.0, f64::max);
    if scale == 0.0 {
        return Err(error(
            "invalid-response",
            "A zero embedding vector cannot be normalized.",
        ));
    }
    let norm = values
        .iter()
        .map(|value| (value / scale).powi(2))
        .sum::<f64>()
        .sqrt();
    for value in &mut values {
        *value = *value / scale / norm;
    }
    Ok(values)
}

fn tensor(raw: &Value, options: &Value) -> Result<Value> {
    if raw.is_string() && options["vectorRepresentation"] == "multi-vector" {
        return Err(error(
            "invalid-response",
            "A base64 tensor without a verified shape cannot be treated as a dense vector. Select float encoding.",
        ));
    }
    if let Some(rows) = raw
        .as_array()
        .filter(|rows| rows.first().is_some_and(Value::is_array))
    {
        if rows.len() > MAX_DIMENSIONS || rows.iter().any(|row| !row.is_array()) {
            return Err(invalid());
        }
        let rows = rows
            .iter()
            .map(|row| normalize(dense(row)?.0, options))
            .collect::<Result<Vec<_>>>()?;
        if rows.iter().any(|row| row.len() != rows[0].len()) {
            return Err(invalid());
        }
        return Ok(json!({"representation":"multi-vector","values":rows,"sourceEncoding":"float"}));
    }
    let (values, encoding) = dense(raw)?;
    Ok(
        json!({"representation":"dense","values":normalize(values, options)?,"sourceEncoding":encoding}),
    )
}

fn sparse(raw: &Value, options: &Value) -> Result<Value> {
    let rows = raw
        .as_array()
        .filter(|rows| rows.len() <= MAX_DIMENSIONS)
        .ok_or_else(invalid)?;
    let mut indices = Vec::with_capacity(rows.len());
    let mut values = Vec::with_capacity(rows.len());
    let mut tokens = Vec::with_capacity(rows.len());
    let mut seen = HashSet::with_capacity(rows.len());
    for row in rows {
        let index = count(&row["token_id"])
            .filter(|index| seen.insert(*index))
            .ok_or_else(invalid)?;
        if !row["token"].is_null() && !row["token"].is_string() {
            return Err(invalid());
        }
        indices.push(index);
        values.push(finite(&row["weight"])?);
        tokens.push(&row["token"]);
    }
    Ok(json!({"indices":indices,"values":normalize(values, options)?,"tokens":tokens}))
}

fn bge(entry: &Value, options: &Value) -> Result<Value> {
    let dense = (!entry["dense_embedding"].is_null())
        .then(|| normalize(self::dense(&entry["dense_embedding"])?.0, options))
        .transpose()?;
    let sparse = (!entry["sparse_embedding"].is_null())
        .then(|| sparse(&entry["sparse_embedding"], options))
        .transpose()?;
    Ok(match (dense, sparse) {
        (Some(values), Some(sparse)) => {
            json!({"representation":"hybrid","values":values,"sparse":sparse,"sourceEncoding":"float"})
        }
        (Some(values), None) => {
            json!({"representation":"dense","values":values,"sourceEncoding":"float"})
        }
        (None, Some(mut sparse)) => {
            sparse["representation"] = json!("sparse");
            sparse["sourceEncoding"] = json!("float");
            sparse
        }
        _ => return Err(invalid()),
    })
}

fn indexed(raw: &Value, count: usize) -> Result<Vec<&Value>> {
    let rows = raw
        .as_array()
        .filter(|rows| rows.len() == count)
        .ok_or_else(invalid)?;
    let mut entries = vec![None; count];
    for entry in rows {
        let index = entry["index"]
            .as_u64()
            .and_then(|index| entries.get_mut(index as usize))
            .ok_or_else(invalid)?;
        if index.replace(entry).is_some() {
            return Err(invalid());
        }
    }
    Ok(entries.into_iter().map(Option::unwrap).collect())
}

pub(super) fn dimensions(vector: &Value) -> Option<usize> {
    match vector["representation"].as_str() {
        Some("sparse") => None,
        Some("multi-vector") => Some(
            vector["values"].as_array().unwrap()[0]
                .as_array()
                .unwrap()
                .len(),
        ),
        _ => Some(vector["values"].as_array().unwrap().len()),
    }
}

pub(super) fn root(raw: &Value, adapter: Adapter) -> &Value {
    if adapter == Adapter::Bge && raw["data"]["data"].is_array() {
        &raw["data"]
    } else {
        raw
    }
}

pub(super) fn parse(
    raw: &Value,
    adapter: Adapter,
    options: &Value,
    count: usize,
) -> Result<Vec<Value>> {
    let root = root(raw, adapter);
    let vectors = match adapter {
        Adapter::Ollama | Adapter::Cohere => {
            let mut entries = &root["embeddings"];
            if adapter == Adapter::Cohere {
                entries = &entries[options["encodingFormat"].as_str().unwrap_or("float")];
            }
            let list = entries
                .as_array()
                .filter(|list| list.len() == count)
                .ok_or_else(invalid)?;
            list.iter()
                .map(|entry| tensor(entry, options))
                .collect::<Result<Vec<_>>>()?
        }
        _ => {
            let entries = indexed(
                if adapter == Adapter::Llama {
                    raw
                } else {
                    &root["data"]
                },
                count,
            )?;
            entries
                .into_iter()
                .map(|entry| {
                    let meta = entry.get("late_chunking");
                    let mut vector = if adapter == Adapter::Bge {
                        bge(entry, options)?
                    } else {
                        let value = &entry[if adapter == Adapter::Pooling {
                            "data"
                        } else {
                            "embedding"
                        }];
                        if value.is_string() && meta.is_some() {
                            return Err(error(
                                "invalid-response",
                                "Select float encoding to preserve chunk-vector boundaries.",
                            ));
                        }
                        tensor(value, options)?
                    };
                    if let Some(description) = meta {
                        vector["metadata"] = json!({"lateChunking":description});
                    }
                    Ok(vector)
                })
                .collect::<Result<Vec<_>>>()?
        }
    };
    let first = &vectors[0];
    let dimension = dimensions(first);
    if !options["vectorRepresentation"].is_null()
        && vectors
            .iter()
            .any(|value| value["representation"] != options["vectorRepresentation"])
    {
        return Err(error(
            "invalid-response",
            "The provider returned a different vector representation than requested.",
        ));
    }
    if vectors.iter().any(|value| {
        value["representation"] != first["representation"] || dimensions(value) != dimension
    }) || dimension
        .zip(options["dimensions"].as_u64())
        .is_some_and(|(actual, expected)| actual as u64 != expected)
    {
        return Err(invalid());
    }
    Ok(vectors)
}
