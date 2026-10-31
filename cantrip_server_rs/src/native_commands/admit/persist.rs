use super::{Admission, optional, text};
use crate::{
    database::Transaction,
    native_commands::settings_persistence,
    wire::{Value, coercion::truthy},
};
use anyhow::{Context, Result};

impl Admission<'_> {
    pub(super) async fn persist(&self, tx: &Transaction<'_>) -> Result<Value> {
        let row = &self.row;
        let input = self.input;
        let operation = text(&row["operation_id"])?;
        let owner = text(&row["owner_id"])?;
        let worker = text(&row["worker_id"])?;
        let chat = text(&row["chat_id"])?;
        let generation = text(&row["operation_generation"])?;
        let logical = optional(&row["logical_operation_id"])?;
        let client = optional(&row["logical_client_message_id"])?;
        let activation = optional(&row["activation_generation"])?;
        let lane = optional(&row["execution_lane_id"])?;
        let origin = text(&row["origin"])?;
        let method = text(&row["method"])?;
        let kind = text(&row["kind"])?;
        let digest = text(&row["payload_digest"])?;
        let payload = row["protected_payload"].stringify();
        let identity = row["identity"].stringify();
        let intent = row["intent"].stringify();
        let reply = (!row["reply_identity"].is_null()).then(|| row["reply_identity"].stringify());
        let status = text(&row["status"])?;
        let rejection = optional(&row["rejection_code"])?;
        let rows=tx.query("INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,logical_operation_id,logical_client_message_id,activation_generation,execution_lane_id,origin,method,kind,payload_digest,protected_payload,identity,intent,reply_identity,status,rejection_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text::jsonb,$15::text::jsonb,$16::text::jsonb,$17::text::jsonb,$18,$19) RETURNING to_jsonb(native_commands)::text",&[&operation,&owner,&worker,&chat,&generation,&logical,&client,&activation,&lane,&origin,&method,&kind,&digest,&payload,&identity,&intent,&reply,&status,&rejection]).await?;
        let inserted: Value = serde_json::from_str(
            &rows
                .first()
                .context("Database returned no row after recording native admission.")?
                .get::<String>(0)?,
        )?;
        settings_persistence::admit_state(tx, &inserted).await?;
        if self.consume_reply && status == "accepted" {
            let runtime = optional(&input["session"]["runtimeGeneration"])?;
            let request = text(&input["reply"]["nativeRequestId"])?;
            tx.query("UPDATE native_pending_requests SET resolution_operation_id=$1 WHERE chat_id=$2 AND runtime_generation=$3 AND native_request_id=$4",&[&operation,&chat,&runtime,&request]).await?;
        }
        if self.starts && status == "accepted" {
            let runtime = optional(&input["session"]["runtimeGeneration"])?;
            let turn = optional(&input["intent"]["expectedTurnId"])?;
            let at = crate::auth::now();
            tx.query("INSERT INTO native_command_activations(chat_id,generation,operation_id,execution_lane_id,worker_id,runtime_generation,native_turn_id,logical_cancelled,active,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,false,true,$8) ON CONFLICT(chat_id) DO UPDATE SET generation=EXCLUDED.generation,operation_id=EXCLUDED.operation_id,execution_lane_id=EXCLUDED.execution_lane_id,worker_id=EXCLUDED.worker_id,runtime_generation=EXCLUDED.runtime_generation,native_turn_id=EXCLUDED.native_turn_id,logical_cancelled=false,active=true,created_at=EXCLUDED.created_at",&[&chat,&activation,&operation,&lane,&worker,&runtime,&turn,&at]).await?;
        }
        let inserted_operation = text(&inserted["operation_id"])?;
        let inserted_generation = text(&inserted["operation_generation"])?;
        if let Some(claim) = self.queue_claim.filter(|v| truthy(Some(v)))
            && status == "accepted"
        {
            let id = text(&claim["id"])?;
            let awaiting =
                input["method"] == "thread/goal/set" && input["intent"]["resumeAutonomy"] == true;
            tx.query("UPDATE managed_queue_claims SET operation_id=$1,operation_generation=$2,status='accepted',awaiting_goal=$3 WHERE id=$4",&[&inserted_operation,&inserted_generation,&awaiting,&id]).await?;
        }
        if truthy(input.get("goalQueueHandoff")) && status == "accepted" {
            let id = text(&input["goalQueueHandoff"]["claimId"])?;
            tx.query("UPDATE managed_queue_claims SET goal_operation_id=$1,goal_operation_generation=$2 WHERE id=$3",&[&inserted_operation,&inserted_generation,&id]).await?;
        }
        Ok(inserted)
    }
}
