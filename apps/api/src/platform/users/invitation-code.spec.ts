import {
  CODE_TTL_MS,
  generateInvitationCode,
  hashInvitationCode,
  invitationCodeMatches,
  issueInvitationCode,
} from './invitation-code.js';

describe('invitation acceptance codes (ADR-012 §PLAT-10)', () => {
  it('generates XXXXX-XXXXX codes from an alphabet without I, L, O, U', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInvitationCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    }
  });

  it('codes differ', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateInvitationCode()));
    expect(seen.size).toBe(500);
  });

  it('matches regardless of case, spaces and the dash; a different code never matches', () => {
    const code = generateInvitationCode();
    const hash = hashInvitationCode(code);
    expect(invitationCodeMatches(code, hash)).toBe(true);
    expect(invitationCodeMatches(code.toLowerCase().replace('-', ' '), hash)).toBe(true);
    expect(invitationCodeMatches(generateInvitationCode(), hash)).toBe(false);
    expect(invitationCodeMatches('', hash)).toBe(false);
  });

  it('stores only a sha256, never the code', () => {
    const now = new Date('2026-11-14T10:00:00Z');
    const { code, data } = issueInvitationCode(now);
    expect(data.inviteCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.inviteCodeHash).not.toContain(code.replace('-', ''));
    expect(data.inviteCodeExpiresAt.getTime() - now.getTime()).toBe(CODE_TTL_MS);
    expect(data.inviteCodeAttempts).toBe(0);
  });
});
