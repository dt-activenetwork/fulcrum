import { describe, test, expect, afterEach } from 'bun:test'
import { isGitUrl, extractRepoNameFromUrl, fetchIfRemoteRef, createGitWorktree, copyFilesToWorktree } from './git-utils'
import { createTestGitRepo, type TestGitRepo } from '../__tests__/fixtures/git'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

describe('git-utils', () => {
  describe('isGitUrl', () => {
    test('recognizes SSH URLs', () => {
      expect(isGitUrl('git@github.com:user/repo.git')).toBe(true)
      expect(isGitUrl('git@gitlab.com:user/repo.git')).toBe(true)
      expect(isGitUrl('git@bitbucket.org:user/repo.git')).toBe(true)
    })

    test('recognizes HTTPS URLs', () => {
      expect(isGitUrl('https://github.com/user/repo.git')).toBe(true)
      expect(isGitUrl('https://gitlab.com/user/repo.git')).toBe(true)
      expect(isGitUrl('https://bitbucket.org/user/repo.git')).toBe(true)
      expect(isGitUrl('https://github.com/user/repo')).toBe(true)
    })

    test('recognizes HTTP URLs', () => {
      expect(isGitUrl('http://github.com/user/repo.git')).toBe(true)
      expect(isGitUrl('http://internal-server/repo.git')).toBe(true)
    })

    test('recognizes shorthand formats', () => {
      expect(isGitUrl('gh:user/repo')).toBe(true) // GitHub shorthand
      expect(isGitUrl('gl:user/repo')).toBe(true) // GitLab shorthand
      expect(isGitUrl('bb:user/repo')).toBe(true) // Bitbucket shorthand
    })

    test('rejects non-git URLs', () => {
      expect(isGitUrl('/path/to/local/repo')).toBe(false)
      expect(isGitUrl('./relative/path')).toBe(false)
      expect(isGitUrl('repo-name')).toBe(false)
      expect(isGitUrl('')).toBe(false)
      expect(isGitUrl('ftp://server/repo.git')).toBe(false)
    })

    test('rejects local paths that look similar', () => {
      expect(isGitUrl('/git@folder/path')).toBe(false)
      expect(isGitUrl('notgit@github.com:user/repo')).toBe(false)
    })
  })

  describe('extractRepoNameFromUrl', () => {
    describe('HTTPS URLs', () => {
      test('extracts name from GitHub URL with .git', () => {
        expect(extractRepoNameFromUrl('https://github.com/user/my-repo.git')).toBe('my-repo')
      })

      test('extracts name from GitHub URL without .git', () => {
        expect(extractRepoNameFromUrl('https://github.com/user/my-repo')).toBe('my-repo')
      })

      test('extracts name from GitLab URL', () => {
        expect(extractRepoNameFromUrl('https://gitlab.com/user/project-name.git')).toBe('project-name')
      })

      test('extracts name from Bitbucket URL', () => {
        expect(extractRepoNameFromUrl('https://bitbucket.org/user/awesome-project.git')).toBe('awesome-project')
      })

      test('extracts name from nested path URL', () => {
        expect(extractRepoNameFromUrl('https://gitlab.com/group/subgroup/repo.git')).toBe('repo')
      })

      test('extracts name from self-hosted URL', () => {
        expect(extractRepoNameFromUrl('https://git.company.com/internal/project.git')).toBe('project')
      })
    })

    describe('SSH URLs', () => {
      test('extracts name from GitHub SSH URL', () => {
        expect(extractRepoNameFromUrl('git@github.com:user/my-repo.git')).toBe('my-repo')
      })

      test('extracts name from GitHub SSH URL without .git', () => {
        expect(extractRepoNameFromUrl('git@github.com:user/my-repo')).toBe('my-repo')
      })

      test('extracts name from GitLab SSH URL', () => {
        expect(extractRepoNameFromUrl('git@gitlab.com:group/repo.git')).toBe('repo')
      })

      test('extracts name from Bitbucket SSH URL', () => {
        expect(extractRepoNameFromUrl('git@bitbucket.org:workspace/project.git')).toBe('project')
      })
    })

    describe('Shorthand URLs', () => {
      test('extracts name from gh: shorthand', () => {
        expect(extractRepoNameFromUrl('gh:user/repo-name')).toBe('repo-name')
      })

      test('extracts name from gl: shorthand', () => {
        expect(extractRepoNameFromUrl('gl:group/project')).toBe('project')
      })

      test('extracts name from bb: shorthand', () => {
        expect(extractRepoNameFromUrl('bb:workspace/repo')).toBe('repo')
      })

      test('handles shorthand without user (returns full string)', () => {
        // When there's no slash, split('/') returns the full string as last element
        expect(extractRepoNameFromUrl('gh:repo-only')).toBe('gh:repo-only')
      })
    })

    describe('Edge cases', () => {
      test('handles repo names with special characters', () => {
        expect(extractRepoNameFromUrl('https://github.com/user/my_repo-v2.git')).toBe('my_repo-v2')
      })

      test('handles repo names with dots', () => {
        expect(extractRepoNameFromUrl('https://github.com/user/repo.name.git')).toBe('repo.name')
      })

      test('handles URLs with trailing slashes', () => {
        expect(extractRepoNameFromUrl('https://github.com/user/repo/')).toBe('')
      })

      test('handles HTTP URLs', () => {
        expect(extractRepoNameFromUrl('http://github.com/user/repo.git')).toBe('repo')
      })
    })
  })

  describe('fetchIfRemoteRef', () => {
    let repo: TestGitRepo

    afterEach(() => {
      repo?.cleanup()
    })

    test('does not fetch for local branch without slash (e.g. "main")', () => {
      repo = createTestGitRepo()
      // Should not throw - just a no-op for local branch names
      fetchIfRemoteRef(repo.path, 'main')
      fetchIfRemoteRef(repo.path, 'master')
      fetchIfRemoteRef(repo.path, 'develop')
    })

    test('does not fetch for local branch with slash that is not a real remote (e.g. "feature/foo")', () => {
      repo = createTestGitRepo()
      // "feature" is not a configured remote, so this should be a no-op
      fetchIfRemoteRef(repo.path, 'feature/foo')
      fetchIfRemoteRef(repo.path, 'bugfix/bar-baz')
    })

    test('fetches for valid remote ref (origin/branch)', () => {
      // Create a "remote" repo and a "local" repo that clones it
      const remoteRepo = createTestGitRepo()
      remoteRepo.commit('remote commit', { 'file.txt': 'hello' })
      remoteRepo.createBranch('develop')
      remoteRepo.commit('develop commit', { 'dev.txt': 'dev' })
      remoteRepo.checkout(remoteRepo.defaultBranch)

      // Clone the remote
      const localPath = mkdtempSync(join(tmpdir(), 'fulcrum-fetch-test-'))
      execSync(`git clone "${remoteRepo.path}" "${localPath}"`, { encoding: 'utf-8' })

      // Add another commit on the remote's develop branch
      remoteRepo.checkout('develop')
      remoteRepo.commit('new develop commit', { 'new.txt': 'new' })
      remoteRepo.checkout(remoteRepo.defaultBranch)

      // Get local origin/develop SHA before fetch
      const beforeSha = execSync('git rev-parse origin/develop', {
        cwd: localPath,
        encoding: 'utf-8',
      }).trim()

      // fetchIfRemoteRef should fetch from origin
      fetchIfRemoteRef(localPath, 'origin/develop')

      // Get local origin/develop SHA after fetch
      const afterSha = execSync('git rev-parse origin/develop', {
        cwd: localPath,
        encoding: 'utf-8',
      }).trim()

      // The SHA should have changed because the remote had a new commit
      expect(afterSha).not.toBe(beforeSha)

      // Cleanup
      remoteRepo.cleanup()
      rmSync(localPath, { recursive: true, force: true })
    })

    test('fetches for remote ref with nested branch name (origin/feature/login)', () => {
      const remoteRepo = createTestGitRepo()
      remoteRepo.createBranch('feature/login')
      remoteRepo.commit('login commit', { 'login.txt': 'login' })
      remoteRepo.checkout(remoteRepo.defaultBranch)

      const localPath = mkdtempSync(join(tmpdir(), 'fulcrum-fetch-test-'))
      execSync(`git clone "${remoteRepo.path}" "${localPath}"`, { encoding: 'utf-8' })

      // Add another commit on the remote's feature/login branch
      remoteRepo.checkout('feature/login')
      remoteRepo.commit('new login commit', { 'new-login.txt': 'new' })
      remoteRepo.checkout(remoteRepo.defaultBranch)

      // fetchIfRemoteRef should fetch feature/login from origin
      fetchIfRemoteRef(localPath, 'origin/feature/login')

      // Verify the ref was updated
      const sha = execSync('git rev-parse origin/feature/login', {
        cwd: localPath,
        encoding: 'utf-8',
      }).trim()

      const remoteSha = remoteRepo.git('rev-parse feature/login')
      expect(sha).toBe(remoteSha)

      // Cleanup
      remoteRepo.cleanup()
      rmSync(localPath, { recursive: true, force: true })
    })

    test('silently handles empty baseBranch', () => {
      repo = createTestGitRepo()
      fetchIfRemoteRef(repo.path, '')
    })

    test('silently handles baseBranch starting with slash', () => {
      repo = createTestGitRepo()
      fetchIfRemoteRef(repo.path, '/foo')
    })
  })

  describe('createGitWorktree', () => {
    let repo: TestGitRepo

    afterEach(() => {
      repo?.cleanup()
    })

    test('creates worktree with new branch from local base', () => {
      repo = createTestGitRepo()
      const worktreePath = join(tmpdir(), `fulcrum-wt-test-${Date.now()}`)

      const result = createGitWorktree(repo.path, worktreePath, 'test-branch', repo.defaultBranch)

      expect(result.success).toBe(true)
      expect(existsSync(worktreePath)).toBe(true)

      // Verify the branch was created
      const branches = repo.git('branch --list')
      expect(branches).toContain('test-branch')
    })

    test('creates parent directories if needed', () => {
      repo = createTestGitRepo()
      const worktreePath = join(tmpdir(), `fulcrum-wt-deep-${Date.now()}`, 'nested', 'path')

      const result = createGitWorktree(repo.path, worktreePath, 'deep-branch', repo.defaultBranch)

      expect(result.success).toBe(true)
      expect(existsSync(worktreePath)).toBe(true)
    })

    test('handles existing branch name gracefully', () => {
      repo = createTestGitRepo()
      repo.createBranch('existing-branch')
      repo.checkout(repo.defaultBranch)

      const worktreePath = join(tmpdir(), `fulcrum-wt-existing-${Date.now()}`)
      const result = createGitWorktree(repo.path, worktreePath, 'existing-branch', repo.defaultBranch)

      expect(result.success).toBe(true)
      expect(existsSync(worktreePath)).toBe(true)
    })

    test('returns error for invalid repo path', () => {
      const result = createGitWorktree('/nonexistent/repo', '/tmp/wt', 'branch', 'main')

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  describe('copyFilesToWorktree', () => {
    let repo: TestGitRepo

    afterEach(() => {
      repo?.cleanup()
    })

    test('copies files matching glob patterns', () => {
      repo = createTestGitRepo()
      // Add some files to the repo
      writeFileSync(join(repo.path, '.env.example'), 'KEY=value')
      writeFileSync(join(repo.path, 'config.json'), '{}')

      const worktreePath = join(tmpdir(), `fulcrum-wt-copy-${Date.now()}`)
      const result = createGitWorktree(repo.path, worktreePath, 'copy-branch', repo.defaultBranch)
      expect(result.success).toBe(true)

      copyFilesToWorktree(repo.path, worktreePath, '.env.example, config.json')

      expect(existsSync(join(worktreePath, '.env.example'))).toBe(true)
      expect(readFileSync(join(worktreePath, '.env.example'), 'utf-8')).toBe('KEY=value')
      expect(existsSync(join(worktreePath, 'config.json'))).toBe(true)
    })

    test('does not overwrite existing files', () => {
      repo = createTestGitRepo()
      writeFileSync(join(repo.path, 'keep.txt'), 'original')

      const worktreePath = join(tmpdir(), `fulcrum-wt-nooverwrite-${Date.now()}`)
      const result = createGitWorktree(repo.path, worktreePath, 'no-overwrite', repo.defaultBranch)
      expect(result.success).toBe(true)

      // Write a different version in the worktree
      writeFileSync(join(worktreePath, 'keep.txt'), 'worktree version')

      copyFilesToWorktree(repo.path, worktreePath, 'keep.txt')

      // Should keep the worktree version
      expect(readFileSync(join(worktreePath, 'keep.txt'), 'utf-8')).toBe('worktree version')
    })

    test('creates nested directories as needed', () => {
      repo = createTestGitRepo()
      mkdirSync(join(repo.path, 'deep', 'nested'), { recursive: true })
      writeFileSync(join(repo.path, 'deep', 'nested', 'file.txt'), 'deep content')

      const worktreePath = join(tmpdir(), `fulcrum-wt-nested-${Date.now()}`)
      const result = createGitWorktree(repo.path, worktreePath, 'nested-copy', repo.defaultBranch)
      expect(result.success).toBe(true)

      copyFilesToWorktree(repo.path, worktreePath, 'deep/**/*')

      expect(existsSync(join(worktreePath, 'deep', 'nested', 'file.txt'))).toBe(true)
      expect(readFileSync(join(worktreePath, 'deep', 'nested', 'file.txt'), 'utf-8')).toBe('deep content')
    })
  })
})
