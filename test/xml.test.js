import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseXml, findAll, findFirst, attr, textOf } from '../lib/xml.js'

const NAMECHEAP_LIST = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <Warnings />
  <RequestedCommand>namecheap.domains.getlist</RequestedCommand>
  <CommandResponse Type="namecheap.domains.getList">
    <DomainGetListResult>
      <Domain ID="1" Name="example.com" User="demo" Created="01/02/2020" Expires="03/15/2027" IsExpired="false" AutoRenew="true" WhoisGuard="ENABLED" IsPremium="false" />
      <Domain ID="2" Name="example.dev" User="demo" Created="01/02/2021" Expires="2028-02-28" IsExpired="false" AutoRenew="false" WhoisGuard="ENABLED" IsPremium="true" />
    </DomainGetListResult>
    <Paging><TotalItems>2</TotalItems><CurrentPage>1</CurrentPage><PageSize>100</PageSize></Paging>
  </CommandResponse>
</ApiResponse>`

test('parses nested XML with attributes and text', () => {
  const root = parseXml(NAMECHEAP_LIST)
  assert.equal(root.name, 'ApiResponse')
  assert.equal(attr(root, 'Status'), 'OK')
  const domains = findAll(root, 'Domain')
  assert.equal(domains.length, 2)
  assert.equal(attr(domains[0], 'Name'), 'example.com')
  assert.equal(attr(domains[1], 'Expires'), '2028-02-28')
  assert.equal(textOf(findFirst(root, 'TotalItems')), '2')
})

test('decodes entities and CDATA', () => {
  const root = parseXml('<r><a title="x &amp; y">A &lt; B</a><b><![CDATA[raw <tag> & stuff]]></b></r>')
  assert.equal(attr(root, 'title'), null)
  assert.equal(attr(findFirst(root, 'a'), 'title'), 'x & y')
  assert.equal(textOf(findFirst(root, 'a')), 'A < B')
  assert.equal(textOf(findFirst(root, 'b')), 'raw <tag> & stuff')
})

test('handles namespaces, self-closing nodes and empty documents', () => {
  const root = parseXml('<nc:Root xmlns:nc="urn:x"><nc:Item Value="1" /></nc:Root>')
  assert.equal(root.name, 'Root')
  assert.equal(attr(findFirst(root, 'Item'), 'Value'), '1')
  assert.equal(parseXml('<empty/>').name, 'empty')
  assert.equal(parseXml('').name, '#empty')
})

test('attribute lookup is case-insensitive', () => {
  const root = parseXml('<r><d Name="a.com" /></r>')
  assert.equal(attr(findFirst(root, 'd'), 'name'), 'a.com')
  assert.equal(attr(findFirst(root, 'd'), 'missing'), null)
})

test('CDATA remains literal and quoted attribute values may contain greater-than signs', () => {
  const root = parseXml('<r value="a > b"><![CDATA[&amp; &#65;]]></r>')
  assert.equal(attr(root, 'value'), 'a > b')
  assert.equal(textOf(root), '&amp; &#65;')
})

test('malformed XML and DTDs are rejected explicitly', () => {
  for (const xml of ['<r><a></r>', '<r>', '<a/><b/>', '</r>', '<r><broken</r>', '<!DOCTYPE r><r/>']) {
    assert.throws(() => parseXml(xml), /XML/)
  }
  for (const entity of ['&#x110000;', '&#0;', '&#xD800;']) {
    assert.throws(() => parseXml(`<r>${entity}</r>`), /invalid XML character reference/)
  }
})

test('XML lookups ignore inherited object properties', () => {
  const root = parseXml('<r>&constructor;</r>')
  assert.equal(attr(root, 'constructor'), null)
  assert.equal(textOf(root), '&constructor;')
})

test('deep XML traversal does not overflow the JavaScript call stack', () => {
  const depth = 12_000
  const root = parseXml('<r>'.repeat(depth) + '<leaf/>' + '</r>'.repeat(depth))
  assert.equal(findAll(root, 'leaf').length, 1)
})
