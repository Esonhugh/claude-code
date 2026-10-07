import {expect,test} from 'bun:test'
import {join} from 'node:path'
import ts from 'typescript'
import {SDKMessageSchema,SDKUILogMessageSchema} from '../entrypoints/sdk/coreSchemas.js'

test('SDK ui_log runtime schemas accept the exact host event and reject invalid fields', () => {
  const message={type:'system',subtype:'ui_log',plugin:'logger',text:'line',uuid:'11111111-1111-4111-8111-111111111111',session_id:'session'} as const
  expect(SDKUILogMessageSchema().parse(message)).toEqual(message)
  expect(SDKMessageSchema().parse(message)).toEqual(message)
  for (const key of ['type','subtype','plugin','text','uuid','session_id']) {
    expect(SDKUILogMessageSchema().safeParse({...message,[key]:3}).success).toBe(false)
    const incomplete={...message};delete incomplete[key as keyof typeof incomplete]
    expect(SDKUILogMessageSchema().safeParse(incomplete).success).toBe(false)
  }
})

test('SDK ui_log is exported in the message union with required string identity fields', () => {
  const path=join(import.meta.dir,'__sdk-log-contract.ts')
  const code=`import type {SDKMessage,SDKUILogMessage} from '../entrypoints/sdk/coreTypes.generated.js';
    type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
    type Assert<T extends true>=T;
    type Shape=Assert<Equal<SDKUILogMessage,{type:'system';subtype:'ui_log';plugin:string;text:string;uuid:string;session_id:string}>>;
    type Member=Assert<Equal<Extract<SDKMessage,{type:'system';subtype:'ui_log'}>,SDKUILogMessage>>;
    const message:SDKMessage={type:'system',subtype:'ui_log',plugin:'logger',text:'line',uuid:'uuid',session_id:'session'};
    // @ts-expect-error A ui_log event must retain the original plugin.
    const missing:SDKUILogMessage={type:'system',subtype:'ui_log',text:'line',uuid:'uuid',session_id:'session'};
    // @ts-expect-error Text cannot become an untyped object.
    const invalid:SDKUILogMessage={...message,text:{line:'line'}};
    export type {Shape,Member};void [message,missing,invalid];`
  const options:ts.CompilerOptions={strict:true,noEmit:true,skipLibCheck:true,target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler}
  const host=ts.createCompilerHost(options),read=host.readFile.bind(host),exists=host.fileExists.bind(host)
  host.readFile=p=>p===path?code:read(p);host.fileExists=p=>p===path||exists(p)
  const diagnostics=ts.getPreEmitDiagnostics(ts.createProgram([path],options,host))
    .map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n'))
  expect(diagnostics).toEqual([])
})
