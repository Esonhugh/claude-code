import { expect, test } from 'bun:test'
import Yoga, { FlexDirection, MeasureMode, Overflow } from './index.js'

test('resizing scroll content repositions a fixed suffix after a flexible label', () => {
  const box = (parent?: ReturnType<typeof Yoga.Node.create>) => {
    const node = Yoga.Node.create()
    node.setFlexDirection(FlexDirection.Column)
    parent?.insertChild(node, parent.getChildCount())
    return node
  }
  const root = box()
  root.setHeight(32)
  const viewport = box(root)
  viewport.setFlexGrow(1)
  viewport.setOverflow(Overflow.Scroll)
  const content = box(viewport)
  content.setFlexGrow(1)
  content.setFlexShrink(0)
  content.setWidthPercent(100)
  const detail = box(content)
  detail.setFlexShrink(0)
  detail.setWidthPercent(100)
  const row = box(detail)
  row.setFlexDirection(FlexDirection.Row)
  row.setFlexShrink(0)
  const labelBox = box(row)
  labelBox.setFlexDirection(FlexDirection.Row)
  labelBox.setFlexGrow(1)
  labelBox.setFlexShrink(1)
  labelBox.setMinWidth(0)
  const label = box(labelBox)
  label.setFlexShrink(1)
  label.setMeasureFunc((width, mode) => ({
    width: mode === MeasureMode.Undefined ? 134 : Math.min(width, 134),
    height: 1,
  }))
  const suffix = box(row)
  suffix.setFlexShrink(0)
  box(suffix).setMeasureFunc(() => ({ width: 6, height: 1 }))

  try {
    for (const width of [61, 37, 36, 37, 78, 37, 78]) {
      root.setWidth(width)
      root.calculateLayout(width, undefined)
      expect(row.getComputedWidth()).toBe(width)
      expect(suffix.getComputedLeft()).toBe(labelBox.getComputedWidth())
      expect(suffix.getComputedLeft() + suffix.getComputedWidth()).toBe(width)
    }
  } finally {
    root.freeRecursive()
  }
})
