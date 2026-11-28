export function register(on) {
  on('ui.render', { surface: 'desktop', component: 'Pane', requestId: 'github-project' }, ($, e) => {
    const { Client } = $.ui.resolve(e)
    return Client({ key: 'github-rows', module: './rows.mjs', props: null })
  })
}
