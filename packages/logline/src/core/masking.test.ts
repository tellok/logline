import { describe, expect, it } from 'vitest';
import { maskString } from './masking';
import { peekObject, safeStringify } from './utils';

describe('maskString', () => {
  it('should mask sensitive query params in URL string', () => {
    const input = 'https://api.example.com/login?auth_code=123456&token=abcdef&other=safe';
    const output = maskString(input);
    expect(output).toContain('auth_code=***');
    expect(output).toContain('token=***');
    expect(output).toContain('other=safe');
  });

  it('should mask comma-separated values', () => {
    const input = 'foo=bar, auth_code=123, baz=qux';
    const output = maskString(input);
    expect(output).toBe('foo=bar, auth_code=***, baz=qux');
  });

  it('should mask sensitive key at start of string', () => {
    const input = 'token=abc';
    const output = maskString(input);
    expect(output).toBe('token=***');
  });

  it('should mask new sensitive key id_token', () => {
    const input = 'id_token=eyjhbgci...&scope=openid';
    const output = maskString(input);
    expect(output).toBe('id_token=***&scope=openid');
  });

  it('should mask sensitive key with whitespace delimiter', () => {
    const input = 'Authorization=Bearer token=secret123';
    const output = maskString(input);
    expect(output).toBe('Authorization=*** token=***');
  });

  it('should mask sensitive key with semicolon delimiter', () => {
    const input = 'Cookie: session=xj32; secure=true';
    const output = maskString(input);
    expect(output).toBe('Cookie: session=***; secure=true');
  });

  it('should handle mixed delimiters', () => {
    const input = 'item_id=value?token=123&secret=456, auth_code=789; pwd=abc';
    const output = maskString(input);
    expect(output).toBe('item_id=value?token=***&secret=***, auth_code=***; pwd=***');
  });

  it('should match longer keys first (id_token vs token)', () => {
    const input = 'id_token=secret_id';
    const output = maskString(input);
    expect(output).toBe('id_token=***');
  });

  it('should not mask non-sensitive keys that contain sensitive substrings', () => {
    const input = 'my_token=123';
    const output = maskString(input);
    expect(output).toBe('my_token=123'); // 'my_token' is not sensitive, and separator check prevents 'token' match inside it
  });

  // ---------- Flexible delimiter tests ----------

  it('should mask sensitive key with colon separator', () => {
    expect(maskString('token: abc123')).toBe('token: ***');
  });

  it('should mask sensitive key with full-width colon separator', () => {
    expect(maskString('token： abc123')).toBe('token： ***');
  });

  it('should mask sensitive key with space-only separator when value is heuristic secret', () => {
    // Mask whitespace-delimited values only when the sensitivity heuristic matches.
    expect(maskString('token 1234567890')).toBe('token ***');
  });

  it('should NOT mask sensitive key with space-only separator when value is plain word', () => {
    // The natural-language phrase session expired should remain visible.
    expect(maskString('session expired')).toBe('session expired');
    expect(maskString('token invalid')).toBe('token invalid');
    expect(maskString('auth failed')).toBe('auth failed');
    expect(maskString('cookie cleared')).toBe('cookie cleared');
  });

  it('should mask sensitive key with spaced = separator', () => {
    expect(maskString('token = abc123')).toBe('token = ***');
  });

  it('should mask id_token with all separator variants', () => {
    expect(maskString('id_token=xxx')).toBe('id_token=***');
    expect(maskString('id_token = xxx')).toBe('id_token = ***');
    // A short whitespace-delimited value does not match the heuristic and remains visible.
    expect(maskString('id_token xxx')).toBe('id_token xxx');
    expect(maskString('id_token: xxx')).toBe('id_token: ***');
    expect(maskString('id_token： xxx')).toBe('id_token： ***');
  });

  it('should not mask non-sensitive key with colon/space separator', () => {
    expect(maskString('name: John')).toBe('name: John');
    expect(maskString('count 42')).toBe('count 42');
  });

  it('should not mask when "value" is followed by = (sub-key scenario)', () => {
    // In Cookie: session=xj32, session is the next key and must remain visible.
    const input = 'Cookie: session=xj32';
    const output = maskString(input);
    // Pass 1 masks session=xj32 without changing Cookie:.
    expect(output).toBe('Cookie: session=***');
  });

  // ---------- Additional sensitive fields ----------

  it('should mask phone-related sensitive keys', () => {
    expect(maskString('phone=13812345678')).toBe('phone=***');
    expect(maskString('tel=021-12345678')).toBe('tel=***');
    expect(maskString('phoneno=13800138000')).toBe('phoneno=***');
    expect(maskString('phone_no=13800138000')).toBe('phone_no=***');
    expect(maskString('telno=021-12345678')).toBe('telno=***');
    expect(maskString('tel_no=021-12345678')).toBe('tel_no=***');
  });

  it('should mask phone keys with colon separator', () => {
    expect(maskString('phone: 13812345678')).toBe('phone: ***');
  });

  it('should NOT mask phone key with space separator when value is not heuristic secret', () => {
    // The hyphenated value in tel 021-12345678 does not match the digit heuristic.
    expect(maskString('tel 021-12345678')).toBe('tel 021-12345678');
  });

  it('should mask phone key with space separator when value is heuristic secret', () => {
    // Digit strings of at least ten characters match the heuristic.
    expect(maskString('phone 13812345678')).toBe('phone ***');
  });

  // ---------- Case-insensitive matching ----------

  it('should be case-insensitive for sensitive keys', () => {
    expect(maskString('TOKEN=abc')).toBe('TOKEN=***');
    expect(maskString('Password=secret')).toBe('Password=***');
    expect(maskString('ACCESS_TOKEN=xyz')).toBe('ACCESS_TOKEN=***');
    expect(maskString('AccessToken=xyz')).toBe('AccessToken=***');
    expect(maskString('PHONE: 138')).toBe('PHONE: ***');
  });

  // ---------- Natural-language false-positive protection ----------

  it('should NOT mask natural language containing sensitive key words', () => {
    const input = 'Account session expired but current route has allowWithoutAccountLogin';
    expect(maskString(input)).toBe(input);
  });

  it('should NOT mask "token is invalid" style natural language', () => {
    expect(maskString('The token is invalid')).toBe('The token is invalid');
    expect(maskString('password reset complete')).toBe('password reset complete');
  });

  // ---------- Digit-string heuristic filtering ----------

  it('should mask pure digit values >= 10 chars regardless of key name', () => {
    expect(maskString('mobile=13812345678')).toBe('mobile=***');
    expect(maskString('cardno=6222021234567890')).toBe('cardno=***');
    expect(maskString('account=1234567890')).toBe('account=***');
  });

  it('should NOT mask pure digit values < 10 chars', () => {
    expect(maskString('port=8080')).toBe('port=8080');
    expect(maskString('count=123456789')).toBe('count=123456789');
  });

  it('should mask Hong Kong phone number via sensitive key', () => {
    expect(maskString('phone=91234567')).toBe('phone=***');
    expect(maskString('tel: 91234567')).toBe('tel: ***');
  });

  it('should mask mainland phone number in unknown key via digit heuristic', () => {
    expect(maskString('contact=13800138000')).toBe('contact=***');
    expect(maskString('receiver=18912345678')).toBe('receiver=***');
  });
});

describe('safeStringify', () => {
  it('should mask pure strings using maskString', () => {
    const input = 'token=123';
    const output = safeStringify(input);
    expect(output).toBe('token=***');
  });

  it('should mask sensitive keys in objects', () => {
    const input = { name: 'Alice', password: 'secretpassword', token: 'xyz' };
    const output = safeStringify(input);
    expect(output).toContain('"password":"***"');
    expect(output).toContain('"token":"***"');
  });

  it('should mask sensitive keys in nested objects', () => {
    const input = { data: { auth_code: '123' } };
    const output = safeStringify(input);
    expect(output).toContain('"auth_code":"***"');
  });

  it('should mask sensitive params in strings inside objects', () => {
    const input = { url: 'https://example.com?auth_code=123' };
    const output = safeStringify(input);
    expect(output).toContain('"url":"https://example.com?auth_code=***"');
  });

  it('should NOT mask generic "code" key (e.g. error code)', () => {
    const input = { code: '901010004', message: 'Request failed' };
    const output = safeStringify(input);
    expect(output).toContain('"code":"901010004"');
  });

  // Heuristic masking tests
  it('should apply heuristic masking to unknown keys with secret-looking values', () => {
    // Synthetic fixture with mixed case and digits, long enough to trigger the heuristic.
    const input = `long_secret=${'SyntheticFixture123'.repeat(2)}`;
    const output = maskString(input);
    expect(output).toBe('long_secret=***');
  });

  it('should NOT mask pure hex strings (e.g. git sha)', () => {
    // 40 chars hex
    const input = 'git_sha=a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4';
    const output = maskString(input);
    // Should remain unmasked because it's pure hex [0-9a-f]
    expect(output).toBe(input);
  });

  it('should mask Base64-encoded secret values containing + and /', () => {
    // Deliberately constructed fixture containing both Base64 symbols.
    const input = `serialNo=${'SyntheticFixture123+/'.repeat(4)}`;
    const output = maskString(input);
    expect(output).toBe('serialNo=***');
  });

  it('should mask Base64-encoded values with trailing padding', () => {
    const input = 'data=dGhpcyBpcyBhIHNlY3JldCB0b2tlbg==';
    const output = maskString(input);
    expect(output).toBe('data=***');
  });

  it('should NOT mask short alphanumeric values', () => {
    const input = 'simple=12345 mixed=abc123';
    const output = maskString(input);
    expect(output).toBe(input);
  });

  it('should NOT mask UUIDs (dashes)', () => {
    const input = 'uuid=550e8400-e29b-41d4-a716-446655440000';
    const output = maskString(input);
    expect(output).toBe(input);
  });

  it('should mask strictly sensitive keys regardless of value format', () => {
    // Even if it looks like a UUID or short number, if key is sensitive, mask it.
    const input = 'token=550e8400-e29b-41d4-a716-446655440000 auth_code=12345';
    const output = maskString(input);
    expect(output).toBe('token=*** auth_code=***');
  });
});

describe('peekObject', () => {
  it('returns full JSON for short objects', () => {
    const input = { foo: 'bar' };
    const output = peekObject(input);
    expect(output).toBe('{"foo":"bar"}');
  });

  it('truncates long objects to 100 characters and appends an ellipsis', () => {
    // Construct an object whose serialized form exceeds 100 characters.
    const input = { data: 'x'.repeat(120) };
    const output = peekObject(input);
    expect(output).toHaveLength(101); // 100 characters plus one ellipsis
    expect(output.endsWith('…')).toBe(true);
  });

  it('supports custom maxLength', () => {
    const input = { name: 'hello', value: 'world' };
    const output = peekObject(input, 10);
    expect(output).toHaveLength(11); // 10 characters plus an ellipsis
    expect(output).toBe('{"name":"h…');
  });

  it('returns the complete string when maxLength is -1', () => {
    const input = { data: 'x'.repeat(200) };
    const output = peekObject(input, -1);
    expect(output).toBe(JSON.stringify(input));
  });

  it('handles primitive values', () => {
    expect(peekObject(42)).toBe('42');
    expect(peekObject(true)).toBe('true');
    expect(peekObject(undefined)).toBe('undefined');
    expect(peekObject(null)).toBe('null');
  });

  it('keeps strings exactly at maxLength intact', () => {
    // {"a":"b"} is nine characters long
    const output = peekObject({ a: 'b' }, 9);
    expect(output).toBe('{"a":"b"}');
  });

  it('masks sensitive fields before truncation', () => {
    const input = { token: 'secret123', name: 'test' };
    const output = peekObject(input, -1);
    expect(output).toContain('"token":"***"');
    expect(output).toContain('"name":"test"');
  });

  it('falls back safely for cyclic references', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    // Must not throw.
    const output = peekObject(obj);
    expect(typeof output).toBe('string');
  });
});
