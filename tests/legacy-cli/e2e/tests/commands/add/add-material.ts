import { expectFileToMatch, rimraf } from '../../../utils/fs';
import { ng } from '../../../utils/process';
import { isPrereleaseCli } from '../../../utils/project';


export default async function () {
  // forcibly remove in case another test doesn't clean itself up
  await rimraf('node_modules/@angular/material');

  const tag = await isPrereleaseCli() ?  '@next' : '';

  try {
    await ng('add', `@angular/material${tag}`, '--unknown');
  } catch (error) {
    if (!(error.message && error.message.includes(`Unknown option: '--unknown'`))) {
      throw error;
    }
  }

  await ng('add',  `@angular/material${tag}`, '--theme', 'custom', '--verbose');
  await expectFileToMatch('package.json', /@angular\/material/);

  const output1 = await ng('add', '@angular/material');
  if (!output1.stdout.includes('Skipping installation: Package already installed')) {
    throw new Error('Installation was not skipped');
  }

  const output2 = await ng('add', '@angular/material@latest');
  if (output2.stdout.includes('Skipping installation: Package already installed')) {
    throw new Error('Installation should not have been skipped');
  }

  const output3 = await ng('add', '@angular/material@8.0.0');
  if (output3.stdout.includes('Skipping installation: Package already installed')) {
    throw new Error('Installation should not have been skipped');
  }

  const output4 = await ng('add', '@angular/material@8');
  if (!output4.stdout.includes('Skipping installation: Package already installed')) {
    throw new Error('Installation was not skipped');
  }
}
