export function register(on){
on("tool.offer",async($,e,next)=>{console.error("EVENT_PROBE tool.offer");return next(e)});
on("tool.judge",async($,e,next)=>{console.error("EVENT_PROBE tool.judge");return next(e)});
on("tool.run",async($,e,next)=>{console.error("EVENT_PROBE tool.run");return next(e)});
on("agent.report",async($,e,next)=>{console.error("EVENT_PROBE agent.report");return next(e)});
on("session.stop",async($,e,next)=>{console.error("EVENT_PROBE session.stop");return next(e)});
on("ui.pointer",async($,e,next)=>{console.error("EVENT_PROBE ui.pointer");return next(e)});
}
