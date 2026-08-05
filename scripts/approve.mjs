#!/usr/bin/env node
// PreToolUse hook: auto-approves ONLY the whydiff pipeline's own operations so
// a /whydiff run does not require a dozen permission prompts. Anything else
// produces no output, which defers to the normal permission flow.
//
// Approved:
//   Bash: node <plugin-root>/scripts/<x>.mjs …      (this plugin's own scripts)
//         git [-C <path>] diff|log|show|ls-files|status …   (read-only git)
//         mkdir -p <…>/.whydiff                      (the working directory)
//         open <…>/.whydiff/<…>.html                 (opening the built map)
//   Write/Edit: files inside a .whydiff/ directory   (the pipeline's outputs)
//
// Never approved: any command with chaining or substitution (; & | ` $( ), and
// any output redirect whose target is outside a .whydiff/ directory.

let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  let reason = null
  try {
    const evt = JSON.parse(input)
    const tool = evt.tool_name
    if (tool === 'Bash') {
      const cmd = String(evt.tool_input?.command || '').trim()
      const root = process.env.CLAUDE_PLUGIN_ROOT
      const unsafe = /[;`&|]|\$\(/.test(cmd)
      // A redirect may only write into the pipeline's own working directory.
      const redirects = [...cmd.matchAll(/>>?\s*(\S+)/g)].map((m) => m[1])
      const badRedirect = redirects.some((t) => !t.includes('.whydiff/'))
      if (cmd && !unsafe && !badRedirect) {
        if (root && cmd.startsWith(`node ${root}/scripts/`)) reason = 'whydiff: bundled pipeline script'
        else if (/^git (-C \S+ )?(diff|log|show|ls-files|status)( |$)/.test(cmd)) reason = 'whydiff: read-only git'
        else if (/^mkdir -p \S*\/?\.whydiff\/?$/.test(cmd)) reason = 'whydiff: working directory'
        else if (/^open \S*\/\.whydiff\/\S+\.html$/.test(cmd)) reason = 'whydiff: open the built map'
      }
    } else if (tool === 'Write' || tool === 'Edit') {
      const p = String(evt.tool_input?.file_path || '')
      if (/\/\.whydiff\//.test(p)) reason = 'whydiff: pipeline output file'
    }
  } catch {}
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason },
    }))
  }
  process.exit(0)
})
