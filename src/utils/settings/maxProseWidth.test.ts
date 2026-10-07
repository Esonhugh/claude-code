import { expect, test } from 'bun:test'
import { SettingsSchema } from './types.js'

test.each([40,41,120])('maxProseWidth accepts %s terminal columns',width=>{
 expect(SettingsSchema().parse({maxProseWidth:width}).maxProseWidth).toBe(width)
})
test.each([39,40.5,'40',null,-1])('maxProseWidth ignores invalid values (%s) like native settings',value=>{
 expect(SettingsSchema().parse({maxProseWidth:value}).maxProseWidth).toBeUndefined()
})
