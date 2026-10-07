// Keep the display projection separate from stored content and API error sentinels.
// Native 2.1.292 DV removes analysis blocks, memory tag wrappers, then leading newlines.
const analysisBlocks = /<(commit_analysis|context|function_analysis|pr_analysis)>.*?<\/\1>\n?/gs
const memoryTags = /<\/?(?:cc-memory|cc_memory|ccmemory|CC-MEMORY|CC_MEMORY|CCMEMORY)(?=[\s/>])[^>]{0,1024}>/g

export function cleanAssistantDisplayText(text: string): string {
  return text.replace(analysisBlocks, '').replace(memoryTags, '').replace(/^\n+/, '')
}
