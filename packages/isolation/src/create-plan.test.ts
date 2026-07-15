import { describe, test, expect } from 'bun:test';

import {
  assertRequestSupported,
  requiredCapabilities,
  resolveStartPoint,
  type ProviderCapabilities,
} from './create-plan';
import { ContainerProvider } from './providers/container';
import { WorktreeProvider } from './providers/worktree';
import type { IsolationRequest } from './types';

const repoPath = '/repo/marphob-page' as unknown as IsolationRequest['canonicalRepoPath'];

function taskRequest(overrides: Partial<IsolationRequest> = {}): IsolationRequest {
  return {
    workflowType: 'task',
    identifier: 'add-rum',
    codebaseId: 'cb1',
    canonicalRepoPath: repoPath,
    ...overrides,
  } as IsolationRequest;
}

function prRequest(overrides: Partial<IsolationRequest> = {}): IsolationRequest {
  return {
    workflowType: 'pr',
    identifier: '389',
    codebaseId: 'cb1',
    canonicalRepoPath: repoPath,
    prBranch: 'feature/x' as unknown as never,
    isForkPR: false,
    ...overrides,
  } as IsolationRequest;
}

describe('resolveStartPoint', () => {
  test('cuts from origin/<base> when no override is given', () => {
    expect(resolveStartPoint(taskRequest(), 'master')).toEqual({
      startPoint: 'origin/master',
      isOverride: false,
    });
  });

  test('an explicit fromBranch overrides the base branch', () => {
    const request = taskRequest({ fromBranch: 'feat/login' as unknown as never });
    expect(resolveStartPoint(request, 'master')).toEqual({
      startPoint: 'feat/login',
      isOverride: true,
    });
  });

  test('fromBranch is only meaningful for task workflows', () => {
    // A PR request carries no fromBranch; the base branch must still win.
    expect(resolveStartPoint(prRequest(), 'master').startPoint).toBe('origin/master');
  });
});

describe('requiredCapabilities', () => {
  test('a plain task request needs nothing', () => {
    expect(requiredCapabilities(taskRequest())).toEqual([]);
  });

  test('--from requires startPointOverride', () => {
    const request = taskRequest({ fromBranch: 'feat/login' as unknown as never });
    expect(requiredCapabilities(request)).toEqual(['startPointOverride']);
  });

  test('every PR workflow requires prCheckout, pinned sha or not', () => {
    expect(requiredCapabilities(prRequest())).toEqual(['prCheckout']);
    expect(requiredCapabilities(prRequest({ prSha: 'abc1234' }))).toEqual(['prCheckout']);
  });

  test('codebaseName is NOT a capability — layout divergence is intentional', () => {
    expect(requiredCapabilities(taskRequest({ codebaseName: 'buun-dev/marphob-page' }))).toEqual(
      []
    );
  });
});

/**
 * The provider contract, asserted against EVERY implementation.
 *
 * This suite is the mechanization for `container-provider-drops-request-field`
 * (retro 2026-07-09). `ContainerProvider` was written by copying the parts of
 * `WorktreeProvider` its author needed; TypeScript checked the methods and
 * nothing checked the fields, so `gitIdentity`, the base branch, and then
 * `fromBranch`/`prSha` were each dropped in silence. Adding a `CapabilityKey`
 * now fails the build until every provider states its position, and this suite
 * proves a provider that says "no" actually refuses rather than ignoring.
 */
const PROVIDERS: [name: string, capabilities: ProviderCapabilities][] = [
  ['worktree', WorktreeProvider.capabilities],
  ['container', ContainerProvider.capabilities],
];

describe.each(PROVIDERS)(
  'provider contract: %s',
  (name: string, capabilities: ProviderCapabilities) => {
    const providerType = name as 'worktree' | 'container';

    test('a request needing nothing is always accepted', () => {
      expect(() => assertRequestSupported(taskRequest(), capabilities, providerType)).not.toThrow();
    });

    test('--from is honored, or refused loudly — never ignored', () => {
      const request = taskRequest({ fromBranch: 'feat/login' as unknown as never });
      const call = () => assertRequestSupported(request, capabilities, providerType);

      if (capabilities.startPointOverride) {
        expect(call).not.toThrow();
        expect(resolveStartPoint(request, 'master').startPoint).toBe('feat/login');
      } else {
        expect(call).toThrow(/fromBranch \(--from\)/);
        expect(call).toThrow(new RegExp(providerType));
      }
    });

    test('a PR is checked out, or refused loudly — never reviewed as its base', () => {
      const request = prRequest({ prSha: 'abc1234' });
      const call = () => assertRequestSupported(request, capabilities, providerType);

      if (capabilities.prCheckout) {
        expect(call).not.toThrow();
      } else {
        expect(call).toThrow(/PR checkout/);
      }
    });
  }
);

describe('ContainerProvider capability declaration', () => {
  test('refuses --from, because sandbox.sh cmd_up takes only a base branch', () => {
    expect(ContainerProvider.capabilities.startPointOverride).toBe(false);
  });

  test('refuses PR checkout: cmd_up would cut sandbox/<slug> from origin/<base>', () => {
    expect(ContainerProvider.capabilities.prCheckout).toBe(false);
  });

  test('create() throws on --from before provisioning anything', async () => {
    const provider = new ContainerProvider();
    const request = taskRequest({ fromBranch: 'feat/login' as unknown as never });
    await expect(provider.create(request)).rejects.toThrow(/cannot honor: fromBranch \(--from\)/);
  });

  test('create() throws on a PR request rather than reviewing the base branch', async () => {
    const provider = new ContainerProvider();
    await expect(provider.create(prRequest())).rejects.toThrow(/PR checkout/);
  });

  // list()'s repo scoping (formerly a hard single-repo refusal) is covered by
  // container.test.ts "list() is scoped to the requested repo" since the
  // multi-repo rollout (feat/isolation-repo-scope).
});

describe('WorktreeProvider capability declaration', () => {
  test('is the reference implementation — honors every capability', () => {
    expect(WorktreeProvider.capabilities).toEqual({
      startPointOverride: true,
      prCheckout: true,
      baseOverride: true,
    });
  });
});

describe('baseOverride capability', () => {
  const taskReq = (extra: Partial<IsolationRequest> = {}): IsolationRequest =>
    ({
      workflowType: 'task',
      identifier: 'slice-a',
      codebaseId: 'cb-1',
      canonicalRepoPath: '/repo' as IsolationRequest['canonicalRepoPath'],
      ...extra,
    }) as IsolationRequest;

  test('requiredCapabilities includes baseOverride when a task sets baseBranch', () => {
    expect(requiredCapabilities(taskReq({ baseBranch: 'epic/x' as never }))).toContain(
      'baseOverride'
    );
  });

  test('requiredCapabilities omits baseOverride when baseBranch is absent', () => {
    expect(requiredCapabilities(taskReq())).not.toContain('baseOverride');
  });

  test('assertRequestSupported throws when provider lacks baseOverride', () => {
    const caps: ProviderCapabilities = {
      startPointOverride: true,
      prCheckout: true,
      baseOverride: false,
    };
    expect(() =>
      assertRequestSupported(taskReq({ baseBranch: 'epic/x' as never }), caps, 'worktree')
    ).toThrow();
  });

  test('assertRequestSupported passes when provider has baseOverride', () => {
    const caps: ProviderCapabilities = {
      startPointOverride: true,
      prCheckout: true,
      baseOverride: true,
    };
    expect(() =>
      assertRequestSupported(taskReq({ baseBranch: 'epic/x' as never }), caps, 'container')
    ).not.toThrow();
  });

  test('both providers declare baseOverride: true', () => {
    expect(ContainerProvider.capabilities.baseOverride).toBe(true);
    expect(WorktreeProvider.capabilities.baseOverride).toBe(true);
  });
});
