import { createContext, useContext } from 'react'

// Frame clock for the demos: main.tsx advances the frame with requestAnimationFrame and the scenes render plain DOM from it.
export const FPS = 30
export const FrameContext = createContext(0)
export const useCurrentFrame = () => useContext(FrameContext)

// Piecewise-linear map of x from input points to output points, clamped at both ends.
export function interpolate(x: number, input: number[], output: number[]): number {
  if (x <= input[0]) return output[0]
  for (let i = 1; i < input.length; i++) {
    if (x <= input[i]) return output[i - 1] + ((x - input[i - 1]) / (input[i] - input[i - 1])) * (output[i] - output[i - 1])
  }
  return output[output.length - 1]
}

export const Sequence: React.FC<{ from?: number; durationInFrames: number; children: React.ReactNode }> = ({ from = 0, durationInFrames, children }) => {
  const frame = useCurrentFrame()
  if (frame < from || frame >= from + durationInFrames) return null
  return <FrameContext.Provider value={frame - from}>{children}</FrameContext.Provider>
}
