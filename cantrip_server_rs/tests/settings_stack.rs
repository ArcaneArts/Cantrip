//! Windows CI exhausted the main stack while validating a settings update.
//! Exercise real migrations, settings reads and both rejected/committed updates
//! on a bounded stack, without changing the server's thread stack allowance.
use anyhow::Result;
use cantrip_server::{
    auth::repository::AuthRepository, database::Database, migrations::migrate,
    settings::repository::SettingsRepository,
};
use futures::FutureExt;
use serde_json::json;
use std::sync::Arc;

#[test]
fn settings_updates_fit_a_one_megabyte_stack() -> Result<()> {
    let root = tempfile::tempdir()?;
    std::thread::Builder::new()
        .name("settings-small-stack".into())
        .stack_size(1024 * 1024)
        .spawn(move || -> Result<()> {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?
                .block_on(async move {
                    let database = Arc::new(
                        Database::pglite(&root.path().join("server-db"))
                            .boxed()
                            .await?,
                    );
                    migrate(&database).boxed().await?;
                    let user = AuthRepository::new(database.clone())
                        .local_user()
                        .boxed()
                        .await?;
                    let repository = SettingsRepository::new(database.clone());
                    repository
                        .ensure_account_configuration(&user.id)
                        .boxed()
                        .await?;
                    assert_eq!(
                        repository.get_settings(&user.id).boxed().await?["preferences"]["theme"],
                        "system"
                    );
                    assert!(
                        repository
                            .update_settings(
                                &user.id,
                                &json!({"labelingModelId":"missing","theme":"dark"})
                            )
                            .boxed()
                            .await?
                            .is_none()
                    );
                    let updated = repository
                        .update_settings(
                            &user.id,
                            &json!({"theme":"dark","computerUseEnabled":true}),
                        )
                        .boxed()
                        .await?
                        .expect("owned update");
                    assert_eq!(updated["preferences"]["theme"], "dark");
                    assert_eq!(updated["preferences"]["computerUseEnabled"], true);
                    let empty = repository
                        .update_settings(&user.id, &json!({}))
                        .boxed()
                        .await?
                        .expect("empty update");
                    assert_eq!(empty["preferences"]["theme"], "dark");
                    database.close().boxed().await?;
                    Ok(())
                })
        })?
        .join()
        .expect("settings thread panicked")
}
