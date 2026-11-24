export function register(on) {
 on('session.start',async($,e,next)=>{const r=await next(e);await $.command.register({name:'themeprobe',description:'Exercise theme set and clear'});return r});
 on('command.run',{command:'themeprobe'},async($)=>{const rows=[];for(const [name,call] of [['SET',()=>$.theme.set({backdrop:{scene:'lagoon'}})],['CLEAR',()=>$.theme.clear()]]){try{rows.push(name+' '+JSON.stringify(await call()))}catch(e){rows.push(name+' ERROR '+String(e))}}return {text:rows.join('\n')}})
}
