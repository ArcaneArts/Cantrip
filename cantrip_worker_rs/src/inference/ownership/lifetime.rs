use super::*;
impl Owner {
    pub fn prepare(&self, runtime: JsString) -> Work<HashMap<String, String>> {
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            if this.0.closed.load(Ordering::Acquire) {
                bail!("Native inference ownership is closed.");
            }
            this.ensure_owner().await?;
            this.control(vec!["--prepare".into(), runtime.lossy().into_owned()])
                .await?;
            if !this.available() {
                bail!("Native inference ownership was lost.");
            }
            Ok(HashMap::from([
                (
                    "CANTRIP_INFERENCE_SCOPE".into(),
                    this.0.directory.to_string_lossy().into_owned(),
                ),
                (
                    "CANTRIP_INFERENCE_GENERATION".into(),
                    this.0.scope.worker_generation.lossy().into_owned(),
                ),
                (
                    "CANTRIP_INFERENCE_RUNTIME".into(),
                    runtime.lossy().into_owned(),
                ),
            ]))
        })
    }
    async fn control(&self, extra: Vec<String>) -> Result<()> {
        let helper = Helper::spawn(
            &self.0.binary,
            self.arguments(extra),
            &self.0.options,
            self.0.scope.worker_generation.clone(),
            true,
            Arc::new(|| {}),
        )?;
        helper.close_input();
        let result = helper.acknowledged().await;
        let closed = helper.close().await;
        result?;
        closed
    }
    pub fn retire(&self, runtime: JsString) -> Work<()> {
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let mut delay = Duration::from_secs(1);
            loop {
                match this
                    .control(vec!["--retire".into(), runtime.lossy().into_owned()])
                    .await
                {
                    Ok(()) => return Ok(()),
                    Err(error) => {
                        this.0.options.report_error(crate::error::message(&error));
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(Duration::from_secs(30));
                    }
                }
            }
        })
    }
    pub fn close(&self) -> Work<()> {
        self.0.closed.store(true, Ordering::Release);
        self.0.owned.store(false, Ordering::Release);
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let helper = this
                .0
                .state
                .lock()
                .unwrap()
                .keeper
                .as_ref()
                .map(|v| v.helper.clone());
            if let Some(helper) = helper {
                helper.close().await?;
            }
            this.0.state.lock().unwrap().listeners.clear();
            Ok(())
        })
    }
}
