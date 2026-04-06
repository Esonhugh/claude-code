export interface WizardContextValue<T = Record<string, unknown>> {
  data: T
  setData: (data: Partial<T>) => void
  step: number
  setStep: (step: number) => void
  totalSteps: number
  goNext: () => void
  goBack: () => void
  isFirst: boolean
  isLast: boolean
  [key: string]: unknown
}

export interface WizardProviderProps {
  children: React.ReactNode
  initialData?: Record<string, unknown>
  totalSteps?: number
  [key: string]: unknown
}

export type WizardStepComponent<T = Record<string, unknown>> = React.ComponentType<{
  data: T
  setData: (data: Partial<T>) => void
  goNext: () => void
  goBack: () => void
  [key: string]: unknown
}>
