import { useSyncExternalStore } from 'react'
import { onGrowthBookRefresh } from '../services/analytics/growthbook.js'
import { onOpenAIModelOptionsRefresh } from '../services/api/bootstrap.js'
import { useAppState } from '../state/AppState.js'
import {
  getDefaultMainLoopModelSetting,
  type ModelName,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'

// The model also depends on state outside AppState: parseUserSpecifiedModel
// reads tengu_ant_model_override (stale disk cache until GrowthBook init
// completes), and the ChatGPT account default comes from model discovery,
// which a fresh install only learns after the first render. Reading it as an
// external store re-resolves it when either refreshes; forcing a re-render is
// not enough, because the React Compiler memoizes this hook on its AppState
// inputs.
function subscribeModelResolution(onChange: () => void): () => void {
  const unsubscribeGrowthBook = onGrowthBookRefresh(onChange)
  const unsubscribeModelOptions = onOpenAIModelOptionsRefresh(onChange)
  return () => {
    unsubscribeGrowthBook()
    unsubscribeModelOptions()
  }
}

// The value of the selector is a full model name that can be used directly in
// API calls. Use this over getMainLoopModel() when the component needs to
// update upon a model config change.
export function useMainLoopModel(): ModelName {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  return useSyncExternalStore(subscribeModelResolution, () =>
    parseUserSpecifiedModel(
      mainLoopModelForSession ??
        mainLoopModel ??
        getDefaultMainLoopModelSetting(),
    ),
  )
}
