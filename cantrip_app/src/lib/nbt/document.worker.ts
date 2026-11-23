/// <reference lib="webworker" />
import { installNbtDocumentWorker } from "@cantrip/nbt/document";
installNbtDocumentWorker(self as unknown as DedicatedWorkerGlobalScope);
