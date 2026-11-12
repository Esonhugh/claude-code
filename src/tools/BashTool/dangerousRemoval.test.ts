import { describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { dirname } from 'path'
import { getParserModule } from '../../utils/bash/bashParser.js'
import { PARSE_ABORTED } from '../../utils/bash/parser.js'
import { checkDangerousRemoval } from './dangerousRemoval.js'

const cwd = '/tmp/dangerous-removal-test/project'

function check(command: string, directory = cwd, env: Record<string, string> = {}) {
  const root = getParserModule()!.parse(command, Infinity)
  expect(root).not.toBeNull()
  return checkDangerousRemoval(command, directory, root, env)
}

function expectMandatory(command: string, directory = cwd, env: Record<string, string> = {}) {
  expect(check(command, directory, env)).toMatchObject({
    behavior: 'ask',
    decisionReason: { type: 'safetyCheck', classifierApprovable: false },
    suggestions: [],
  })
}

describe('dangerous removal analysis', () => {
  test('sees removals behind exec, setsid, ionice, busybox, doas and pkexec', () => {
    for (const command of [
      'exec rm -rf /',
      'exec -a name rm -rf /',
      'setsid -f rm -rf /',
      'ionice -c 3 rm -rf /',
      'busybox rm -rf /',
      'doas -u root rm -rf /',
      'pkexec --user root rm -rf /',
      "exec sh -c 'rm -rf /'",
    ])
      expectMandatory(command)
    expect(check('exec rm -rf build').behavior).toBe('passthrough')
  })
  test('asks for a shell -c script built from a variable when the command mentions rm', () => {
    expectMandatory('CMD="rm -rf /"; bash -c "$CMD"')
    expect(check('CMD="ls"; bash -c "$CMD"').behavior).toBe('passthrough')
  })
  test('requires explicit approval for rm -rf "$HOME/.config"', () => {
    expectMandatory('rm -rf "$HOME/.config"', cwd, { HOME: homedir() })
  })
  test('does not ask for env split-string removals it cannot read, like official', () => {
    for (const command of ['env -S"rm ordinary"', 'env -S"/bin/rm ordinary"', 'env -S"echo rm /"'])
      expect(check(command).behavior).toBe('passthrough')
  })
  test('does not treat non-expanding dollar signs or braces as dynamic targets', () => {
    for (const command of [
      'rm ordinary$',
      'rm "$"',
      'rm {}',
      'rm ordinary{literal}',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('handles long unfinished brace expressions without repeated suffix scans', () => {
    const command = `echo a${'{,'.repeat(2400)}`
    const root = getParserModule()!.parse(command, Infinity)
    expect(root).not.toBeNull()
    const start = performance.now()
    expect(checkDangerousRemoval(command, cwd, root, {}).behavior).toBe(
      'passthrough',
    )
    // A broad ceiling catches multi-second blocking, not microbenchmark noise.
    expect(performance.now() - start).toBeLessThan(2000)
    for (const target of [
      '{one,two}',
      '{1..3}',
      '{one,{two,three}}',
      "'{one,two}'",
      '{one\\,two}',
      '{one",two"}',
      '{'.repeat(4800),
    ]) {
      expect(check(`rm ${target}`).behavior).toBe('passthrough')
    }
  }, 30000)

  test('checks find behind wrappers with unknown semantics by its roots', () => {
    expectMandatory('nice --unknown find / -delete')
    for (const command of [
      'nice --unknown find /tmp/project -delete',
      'xargs find /tmp/project -delete',
      'nice --unknown find /tmp/project -print',
    ])
      expect(check(command).behavior).toBe('passthrough')
  })
  test('does not infer a removal target from wrapper uncertainty alone', () => {
    for (const command of [
      'env -C /tmp rm --help',
      'nice --unknown rm --version',
      'sudo --unknown rmdir',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('leaves unrelated command names alone, including ordinary object property names', () => {
    for (const command of [
      'constructor --flag',
      'toString --flag',
      '__proto__ --flag',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('supports BSD find explicit roots without treating option values as actions', () => {
    expectMandatory('find -f / -delete')
    expect(check('find -f /tmp/project -delete').behavior).toBe('passthrough')
    expect(check('find -f -delete -print').behavior).toBe('passthrough')
  })
  test('does not ask for externally supplied find roots, like official', () => {
    for (const command of [
      'find -files0-from roots.list -delete',
      'find -files0-from - -exec rm {} +',
      'find -files0-from roots.list -print',
    ])
      expect(check(command).behavior).toBe('passthrough')
  })
  test('preserves protected lexical paths while normalizing targets without filesystem access', () => {
    for (const command of [
      'rm ~/.config/../ordinary',
      'rm ~/.codex/../ordinary',
      'rm ~/.config/nested/file',
      'rm ~/.codex/data',
      'rm ~/.bashrc',
      'rm ~/.zshrc.bak',
      'rm ~',
      'rm /tmp',
      'rm /usr',
      'rm /tmp/project/../..',
    ]) {
      expectMandatory(command)
    }
    for (const command of [
      'rm ~/ordinary',
      'rm /tmp/project/nested',
      'rm ~/.config-other/file',
      'rm ~/.bashrc.other',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('reports unavailable parsing as not analyzed rather than a safe result', () => {
    for (const aborted of [false, true]) {
      for (const command of ['rm /', 'echo ordinary', 'cat <<EOF\nrm /\nEOF']) {
        const result = checkDangerousRemoval(
          command,
          cwd,
          aborted ? PARSE_ABORTED : null,
          {},
        )
        expect(result.behavior).toBe('passthrough')
        expect('message' in result && result.message).toMatch(/not analyzed/i)
      }
    }
  })
  test('checks direct find exec removals and limited placeholders, ignoring action-looking exec arguments', () => {
    for (const command of [
      'find /tmp -exec rm {} \\;',
      'find /tmp -execdir rmdir {} +',
      'find /tmp/project -exec /bin/rm /etc \\;',
      'find /tmp/project -exec unlink "$TARGET"/ \\;',
    ]) {
      expectMandatory(command)
    }
    for (const command of [
      'find /tmp/project -exec unlink "$TARGET" \\;',
      'find /tmp/project -exec rm "{}/../.." \\;',
      'find /tmp/project -execdir rm ../relative \\;',
      'find /tmp/project -exec rm {} +',
      'find /tmp/project -execdir rm {} \\;',
      'find /tmp -exec echo -delete \\;',
      'find /tmp -exec echo rm / \\;',
      'find /tmp -exec bash -c "rm /" \\;',
      'find /tmp -name "-exec"',
      'find /tmp/project -exec rm --help \\;',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('checks destructive find traversal roots and protected ancestors, not every root-child descendant', () => {
    for (const command of [
      'find / -delete',
      'find /tmp -name ordinary -delete',
      'find ~/.config -delete',
      `find '${dirname(homedir())}' -delete`,
      'find "$SEARCH"/ -delete',
      'cd /tmp; find . -delete',
    ]) {
      expectMandatory(command)
    }
    for (const command of [
      'find $SEARCH -delete',
      'cd "$SEARCH"; find . -delete',
      'find /tmp/ordinary-project -delete',
      'find / -print',
      'find /tmp -name "-delete"',
      'find /tmp -newer "-delete"',
      'find /tmp -newermt "-delete"',
      'find /tmp -name "-exec" -print',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('does not ask for xargs deletion targets supplied by input, like official', () => {
    for (const command of [
      'xargs rm',
      'echo ordinary | xargs -0 -r -n 1 rm -f',
      'xargs -I {} /bin/rm {}',
      'xargs -a list -d "\\n" -P2 rmdir',
      'xargs --max-args=1 -- unlink',
      'xargs -0 sudo rm',
      'xargs --unknown value rm',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
    for (const command of [
      'xargs echo rm /',
      'xargs -I rm echo rm',
      'echo rm | xargs',
      'xargs -a rm echo ok',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('asks for a whole-directory glob after a cwd change, not other relative targets', () => {
    for (const command of [
      'cd /tmp && rm -rf *',
      'pushd /tmp; rm -rf ./*',
      '{ cd /tmp; }; rm -rf *',
    ]) {
      expectMandatory(command)
    }
    for (const command of [
      'cd /tmp && rm ordinary',
      'pushd /tmp; rm ordinary',
      'popd; rm ordinary',
      '{ cd /tmp; }; rm ordinary',
      'cd /tmp; rm --help; rm ordinary',
      'cd /tmp && rm *.log',
      'cd /tmp; rm /tmp/project/ordinary',
      'rm ordinary; cd /tmp',
      '(cd /tmp); rm ordinary',
      'echo "$(cd /tmp)"; rm ordinary',
      'cd /tmp | cat; rm ordinary',
      'f() { cd /tmp; }; rm ordinary',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('asks for unresolved targets only when they can reach a protected path or cover the working directory', () => {
    for (const command of [
      'rm -rf "$OTHER"/',
      'rm -rf ${OTHER}/*',
      'rm -rf $OTHER/usr',
      'rm -rf "$(printf x)"/',
      'rm -rf *',
      'rm -rf ./*',
      'rm -rf ../*',
      'rm -rf ~/*',
      'rm -rf /usr/*',
      'rm -f /*.log',
    ]) {
      expectMandatory(command)
    }
    for (const command of [
      'rm $OTHER',
      'rm "$HOME/ordinary"',
      'rm ${HOME}/.config',
      'rm $(printf ordinary)',
      'rm `printf ordinary`',
      'rm <(printf ordinary)',
      'rm ordinary*',
      'rm *.log',
      'rm -rf build/*',
      'rm {one,two}',
      "rm $'ordinary'",
      'rm ~other/file',
      'for f in *.o; do rm -f "$f"; done',
      'ls *.tmp | xargs rm -f',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('checks targets behind cwd-changing, split-string and unknown wrappers like plain removals', () => {
    for (const command of ['nice --unknown value rm /', 'sudo -D /tmp rm -rf /usr'])
      expectMandatory(command)
    for (const command of [
      'env -C /tmp rm ordinary',
      'env --chdir=/tmp rm ordinary',
      'env -S "rm ordinary"',
      'env --split-string="rm ordinary"',
      'nice --unknown value rm ordinary',
      'sudo -D /tmp rm ordinary',
      'env -C /tmp echo rm /',
      'env -S "echo rm /"',
      'env --unknown echo ok',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('recognizes a bounded set of deletion wrappers without treating query arguments as execution', () => {
    for (const command of [
      'nice -n 5 rm /',
      'timeout -s TERM 2s rm /',
      'time -p rm /',
      'nohup rm /',
      'stdbuf -oL rm /',
      'env MODE=test rm /',
      'command -p rm /',
      'sudo -u root rm /',
      '/usr/bin/nice /bin/rm /',
    ]) {
      expectMandatory(command)
    }
    for (const command of [
      'command -v rm',
      'command -V /bin/rm',
      'env echo rm /',
      'nice echo rm /',
      'sudo echo rm /',
      'timeout 2s echo rm /',
      'env X="rm /" echo ok',
      'nice rm ordinary',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('visits executable command positions but not definitions, text, or heredocs', () => {
    for (const command of [
      'true && rm /',
      '(rm /)',
      '{ rm /; }',
      'true | rm /',
      'if true; then rm /; fi',
      'for x in a; do rm /; done',
      'echo "$(rm /)"',
      'cat <(rm /)',
      'bash -c "rm /"',
      "sh -ec 'cd /tmp && rm -rf /'",
    ]) {
      expectMandatory(command)
    }
    for (const command of [
      'f() { rm /; }',
      'cat <<EOF\nrm /\nEOF',
      "echo '$(rm /)'",
      'echo rm /',
      'bash -c "echo rm /"',
      'bash script.sh rm /',
      'eval "rm /"',
      'python -c "rm /"',
      'mv /tmp/a /tmp/b',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('recognizes all direct removal commands, absolute executables, and -- operands', () => {
    for (const command of [
      'rmdir /tmp',
      'unlink /etc',
      '/bin/rm -rf /',
      'rm -- -/../../..',
      'rm /t"mp"',
      'rm /tmp/../etc',
    ]) {
      expectMandatory(command)
    }
    for (const command of [
      'rm --help',
      'rm --version',
      'rmdir',
      'unlink',
      'rm -rf ordinary',
      'echo "rm /"',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
  test('resolves plain variables from the environment snapshot without evaluating the shell', () => {
    const env = {
      BUILD_DIR: 'build',
      TMPDIR: '/tmp/dangerous-removal-test/tmp/',
      SPACED: 'build out',
      GLOB: 'build/*',
      ROOT: '/',
      HOME: homedir(),
      EMPTY: '',
      PWD: '/tmp/dangerous-removal-test/project',
      _: '/tmp/dangerous-removal-test/project',
    }
    for (const command of [
      'rm -rf "$BUILD_DIR"',
      'rm -rf ${BUILD_DIR}/out',
      'rm -rf "$TMPDIR/cc-x"',
      'rm -rf $TMPDIR',
      'rm -rf "$SPACED"',
      'rm -rf "$GLOB"',
      'find $BUILD_DIR -delete',
      'cd /tmp && rm -rf "$TMPDIR/cc-x"',
      'rm -rf $SPACED',
      'rm -rf $GLOB',
      'rm -rf "$MISSING"',
      'rm -rf "$constructor"',
      'rm -rf "$PWD"',
      'rm -rf "$_"',
      'rm -rf "${BUILD_DIR:-build}"',
      'rm -rf "$BUILD_DIR[1]"',
      'rm -rf "$BUILD_DIR:h"',
      'cd /tmp && rm -rf "$BUILD_DIR"',
    ]) {
      expect(check(command, cwd, env).behavior).toBe('passthrough')
    }
    for (const command of [
      'rm -rf "$ROOT"',
      'rm -rf $HOME',
      'rm -rf "${HOME}/.config"',
      'find "$HOME" -delete',
      'rm -rf "$EMPTY/"',
      'rm -rf "$MISSING"/',
      'rm -rf "${BUILD_DIR:-build}"/',
    ]) {
      expectMandatory(command, cwd, env)
    }
  })
  test('tries literal assignments when the command can assign variables', () => {
    const env = { BUILD_DIR: 'build' }
    for (const command of [
      'BUILD_DIR=/; rm -rf "$BUILD_DIR"',
      'export BUILD_DIR=/; rm -rf "$BUILD_DIR"',
      'unset BUILD_DIR; rm -rf "$BUILD_DIR/"',
      'f() { BUILD_DIR=/; }; f; rm -rf "$BUILD_DIR"',
      'BUILD_DIR=out; BUILD_DIR=/usr; rm -rf "$BUILD_DIR"',
      'CMD="rm -rf /"; sh -c "$CMD"',
    ]) {
      expectMandatory(command, cwd, env)
    }
    for (const command of [
      'BUILD_DIR=out; rm -rf "$BUILD_DIR"',
      'X=sub; rm -f $X/c.txt',
      'read BUILD_DIR; rm -rf "$BUILD_DIR"',
      'source ./env.sh; rm -rf "$BUILD_DIR"',
    ]) {
      expect(check(command, cwd, env).behavior).toBe('passthrough')
    }
  })
  test('treats zsh parameter forms as expansions', () => {
    const env = { HOME: homedir() }
    for (const command of [
      'rm -rf $~HOME',
      'rm -rf $=HOME',
      'rm -rf $^HOME',
    ]) {
      expectMandatory(command, cwd, env)
    }
    expect(check('rm cost$=literal', cwd, env).behavior).toBe('passthrough')
  })
  test('treats quoted and escaped shell expansions as literal paths', () => {
    for (const command of [
      "rm '$HOME/.config'",
      'rm \\$HOME/.config',
      'rm "~/.config"',
      "rm '~/.config'",
      'rm "ordinary file"',
      'rm \\*',
    ]) {
      expect(check(command).behavior).toBe('passthrough')
    }
  })
})
