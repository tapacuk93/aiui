// deploy/services.yaml: the revision pieces are there and wired, and cfn-lint passes (when installed:
// cfn-lint on PATH, or CFN_LINT=/path/to/cfn-lint).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const template = readFileSync(new URL('../../deploy/services.yaml', import.meta.url), 'utf8');
const block = (name) => template.split(/\n(?=  [A-Za-z]+:\n)/).find((b) => b.startsWith(`  ${name}:\n`)) || '';

test('the template has the change log, the delayed trigger and the review switch', () => {
  assert.match(block('ChangesTable'), /AttributeName: seq, AttributeType: N/);
  assert.match(block('RevisionsQueue'), /DelaySeconds: 90/);
  assert.match(block('RevisionsQueue'), /VisibilityTimeout: 900/, 'at least the mirror timeout (600 s)');
  assert.match(block('MirrorQueueTrigger'), /Type: AWS::Lambda::EventSourceMapping[\s\S]*Enabled: !If \[MirrorOn, true, false\]/);
  assert.match(block('ApiRole'), /sqs:SendMessage\][\s\S]*RevisionsQueue/);
  assert.match(block('ApiRole'), /dynamodb:PutItem\]\n\s+Resource: !GetAtt ChangesTable.Arn/);
  assert.match(block('MirrorRole'), /"meta:\*", "lock:\*"/);
  assert.match(block('MirrorRole'), /payloads\/\*[\s\S]*state\/\*/);
  assert.match(block('MirrorRole'), /ReviewOn[\s\S]*ReviewSecretName/);
  assert.match(block('ApiFunction'), /REVISIONS_QUEUE_URL: !If \[MirrorOn, !Ref RevisionsQueue, ""\]/);
  assert.match(block('MirrorFunction'), /REVIEW_SECRET: !If \[ReviewOn, !Ref ReviewSecretName, ""\]/);
  assert.match(block('ReviewEnabled'), /Default: "false"/);
});

test('cfn-lint passes', (t) => {
  const lint = process.env.CFN_LINT || 'cfn-lint';
  if (spawnSync(lint, ['--version']).status !== 0) return t.skip('cfn-lint is not installed');
  const dir = mkdtempSync(join(tmpdir(), 'cfn-'));
  try {
    const file = join(dir, 'services.yaml');
    writeFileSync(file, template.replace(/Code: \.\.\/build\/services-lambda.*/g, 'Code: {S3Bucket: placeholder, S3Key: services.zip}'));
    const r = spawnSync(lint, [file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
