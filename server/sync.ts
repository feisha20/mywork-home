import type { Config } from './config.js'
import type { Extractor } from './harness.js'
import type { SettingsService } from './settings.js'
import type { Store } from './store.js'
import { messageBatches } from './sync/extractionBatcher.js'
import { SyncOrchestrator } from './sync/syncOrchestrator.js'

export { messageBatches }

export class SyncService extends SyncOrchestrator {
  constructor(store: Store, config: Config, extractor: Extractor, settings?: SettingsService) {
    super(store, config, extractor, settings)
  }
}
