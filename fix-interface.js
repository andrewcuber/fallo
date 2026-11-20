const fs = require('fs');

let rg = fs.readFileSync('lib/rotation-generator.ts', 'utf8');

const replacement = `export interface GeminiClientLike {
  models: {
    generateContent: (params: any) => Promise<any>;
  };
  interactions?: {
    create: (params: any, options?: any) => Promise<any>;
  };
}`;

const startIndex = rg.indexOf('export interface GeminiClientLike');
const endIndex = rg.indexOf('}', startIndex);

if (startIndex !== -1 && endIndex !== -1) {
  rg = rg.substring(0, startIndex) + replacement + rg.substring(endIndex + 1);
  fs.writeFileSync('lib/rotation-generator.ts', rg);
  console.log("Interface replaced.");
} else {
  console.log("Could not replace interface.");
}

// In test-generation.ts, we need to make sure models is defined for every clientFactory
let testGen = fs.readFileSync('test-generation.ts', 'utf8');
// This is trickier since there are multiple test cases.
// We can just find all `interactions: {` and make sure `models: { generateContent: async (params: any) => ({}) },` is added before it
testGen = testGen.replace(/clientFactory: \(\) => \(\{\s*interactions:/g, 'clientFactory: () => ({\n        models: { generateContent: async (params: any) => ({}) },\n        interactions:');
testGen = testGen.replace(/clientFactory: \(opts\) => \{\s*captured/g, 'clientFactory: (opts: any) => {\n      captured');
testGen = testGen.replace(/return \{\s*interactions:/g, 'return {\n        models: { generateContent: async (params: any) => ({}) },\n        interactions:');
fs.writeFileSync('test-generation.ts', testGen);

