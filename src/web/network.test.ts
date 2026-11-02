import { describe, expect, it } from 'bun:test'
import { addressKind, isAllowedPeer, resolveBindHost } from './network.js'

describe('addressKind', () => {
  it('recognises loopback', () => {
    for (const ip of ['127.0.0.1', '127.8.9.10', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
      expect(addressKind(ip)).toBe('loopback')
    }
  })

  it('recognises private, link-local, CGNAT and ULA ranges', () => {
    for (const ip of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.20',
      '169.254.3.4',
      '100.64.0.1',
      '100.127.255.254',
      'fe80::1',
      'fe80::1%eth0',
      'febf::1',
      'fc00::1',
      'fd12:3456:789a::1',
    ]) {
      expect(addressKind(ip)).toBe('lan')
    }
  })

  it('classifies IPv4-mapped IPv6 by the IPv4 part', () => {
    expect(addressKind('::ffff:127.0.0.1')).toBe('loopback')
    expect(addressKind('::ffff:192.168.0.5')).toBe('lan')
    expect(addressKind('::ffff:c0a8:5')).toBe('lan')
    expect(addressKind('0:0:0:0:0:ffff:7f00:1')).toBe('loopback')
    expect(addressKind('::ffff:8.8.8.8')).toBe('other')
    expect(addressKind('::ffff:808:808')).toBe('other')
  })

  it('rejects public, unspecified and malformed addresses', () => {
    for (const ip of [
      '8.8.8.8',
      '172.15.0.1',
      '172.32.0.1',
      '100.63.255.255',
      '100.128.0.1',
      '192.169.0.1',
      '0.0.0.0',
      '::',
      '2001:4860:4860::8888',
      'fec0::1',
      'fe00::1',
      '::127.0.0.1',
      '64:ff9b::7f00:1',
      'localhost',
      'example.com',
      '',
    ]) {
      expect(addressKind(ip)).toBe('other')
    }
    expect(isAllowedPeer(undefined)).toBe(false)
    expect(isAllowedPeer('203.0.113.9')).toBe(false)
    expect(isAllowedPeer('192.168.1.2')).toBe(true)
  })
})

describe('resolveBindHost', () => {
  it('defaults to loopback, or every interface with the flag', () => {
    expect(resolveBindHost(undefined, false)).toEqual({ host: '127.0.0.1' })
    expect(resolveBindHost(undefined, true)).toEqual({ host: '0.0.0.0' })
  })

  it('accepts loopback hosts with or without the flag', () => {
    expect(resolveBindHost('localhost', false)).toEqual({ host: 'localhost' })
    expect(resolveBindHost('[::1]', false)).toEqual({ host: '::1' })
    expect(resolveBindHost('127.0.0.1', true)).toEqual({ host: '127.0.0.1' })
  })

  it('needs the flag for a LAN host, which then wins over 0.0.0.0', () => {
    expect(resolveBindHost('192.168.1.5', false)).toHaveProperty('error')
    expect(resolveBindHost('192.168.1.5', true)).toEqual({ host: '192.168.1.5' })
    expect(resolveBindHost('fd00::5', true)).toEqual({ host: 'fd00::5' })
  })

  it('refuses public and wildcard hosts even with the flag', () => {
    for (const host of ['0.0.0.0', '::', '8.8.8.8', '2001:db8::1', 'example.com']) {
      expect(resolveBindHost(host, true)).toHaveProperty('error')
      expect(resolveBindHost(host, false)).toHaveProperty('error')
    }
  })
})
