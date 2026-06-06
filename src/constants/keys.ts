import { isEnvTruthy } from '../utils/envUtils.js'
import { isAnt } from 'src/utils/userType.js'


// Lazy read so ENABLE_GROWTHBOOK_DEV from globalSettings.env is picked up.
export function getGrowthBookClientKey(): string {
  return isAnt()
    ? isEnvTruthy(process.env.ENABLE_GROWTHBOOK_DEV)
      ? 'sdk-yZQvlplybuXjYh6L'
      : 'sdk-xRVcrliHIlrg4og4'
    : 'sdk-zAZezfDKGoZuXXKe'
}
