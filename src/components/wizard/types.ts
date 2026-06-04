export interface WizardContextValue<T = Record<string, unknown>> {
  currentStepIndex: number
  totalSteps: number
  wizardData: T
  setWizardData: React.Dispatch<React.SetStateAction<T>>
  updateWizardData: (updates: Partial<T>) => void
  goNext: () => void
  goBack: () => void
  goToStep: (index: number) => void
  cancel: () => void
  title?: string
  showStepCounter: boolean
}

export interface WizardProviderProps<T = Record<string, unknown>> {
  steps: WizardStepComponent<T>[]
  initialData?: T
  onComplete: (data: T) => void | Promise<void>
  onCancel?: () => void
  children?: React.ReactNode
  title?: string
  showStepCounter?: boolean
}

export type WizardStepComponent<T = Record<string, unknown>> = React.ComponentType
