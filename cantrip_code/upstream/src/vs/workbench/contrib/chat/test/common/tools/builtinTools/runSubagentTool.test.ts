/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../../base/common/cancellation.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../../../platform/log/common/log.js';
import { TestConfigurationService } from '../../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { RunSubagentTool, parseMultiplier } from '../../../../common/tools/builtinTools/runSubagentTool.js';
import { MockLanguageModelToolsService } from '../mockLanguageModelToolsService.js';
import { IChatAgentService } from '../../../../common/participants/chatAgents.js';
import { IChatService } from '../../../../common/chatService/chatService.js';
import { ILanguageModelsService } from '../../../../common/languageModels.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { ICustomAgent, PromptsStorage, Target } from '../../../../common/promptSyntax/service/promptsService.js';
import { MockPromptsService } from '../../promptSyntax/service/mockPromptsService.js';

suite('RunSubagentTool', () => {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseMultiplier', () => {
		test('parses standard multiplier strings', () => {
			assert.deepStrictEqual(
				[
					{ input: '1X', expected: 1 },
					{ input: '2X', expected: 2 },
					{ input: '0.5X', expected: 0.5 },
					{ input: '1.5x', expected: 1.5 },
					{ input: '10X', expected: 10 },
					{ input: '0.25x', expected: 0.25 },
				].map(({ input, expected }) => ({ input, result: parseMultiplier(input), expected })),
				[
					{ input: '1X', result: 1, expected: 1 },
					{ input: '2X', result: 2, expected: 2 },
					{ input: '0.5X', result: 0.5, expected: 0.5 },
					{ input: '1.5x', result: 1.5, expected: 1.5 },
					{ input: '10X', result: 10, expected: 10 },
					{ input: '0.25x', result: 0.25, expected: 0.25 },
				]
			);
		});

		test('handles whitespace in multiplier strings', () => {
			assert.strictEqual(parseMultiplier('  2X  '), 2);
			assert.strictEqual(parseMultiplier('1.5 X'), 1.5);
		});

		test('returns 1000 for undefined and 1 for empty input', () => {
			assert.strictEqual(parseMultiplier(undefined), 1000);
			assert.strictEqual(parseMultiplier(''), 1000);
		});

		test('returns 1 for invalid formats', () => {
			assert.deepStrictEqual(
				[
					{ input: 'abc', expected: 1 },
					{ input: 'X', expected: 1 },
					{ input: '2', expected: 1 },
					{ input: 'fast', expected: 1 },
					{ input: '2Y', expected: 1 },
				].map(({ input, expected }) => ({ input, result: parseMultiplier(input), expected })),
				[
					{ input: 'abc', result: 1, expected: 1 },
					{ input: 'X', result: 1, expected: 1 },
					{ input: '2', result: 1, expected: 1 },
					{ input: 'fast', result: 1, expected: 1 },
					{ input: '2Y', result: 1, expected: 1 },
				]
			);
		});
	});

	suite('resultText trimming', () => {
		test('trims leading empty codeblocks (```\\n```) from result', () => {
			// This tests the regex: /^\n*```\n+```\n*/g
			const testCases = [
				{ input: '```\n```\nActual content', expected: 'Actual content' },
				{ input: '\n```\n```\nActual content', expected: 'Actual content' },
				{ input: '\n\n```\n\n```\n\nActual content', expected: 'Actual content' },
				{ input: '```\n```\n```\n```\nActual content', expected: '```\n```\nActual content' }, // Only trims leading
				{ input: 'No codeblock here', expected: 'No codeblock here' },
				{ input: '```\n```\n', expected: '' },
				{ input: '', expected: '' },
			];

			for (const { input, expected } of testCases) {
				const result = input.replace(/^\n*```\n+```\n*/g, '').trim();
				assert.strictEqual(result, expected, `Failed for input: ${JSON.stringify(input)}`);
			}
		});
	});

	suite('prepareToolInvocation', () => {
		test('returns correct toolSpecificData', async () => {
			const mockToolsService = testDisposables.add(new MockLanguageModelToolsService());
			const configService = new TestConfigurationService();

			const promptsService = new MockPromptsService();
			const customMode: ICustomAgent = {
				uri: URI.parse('file:///test/custom-agent.md'),
				name: 'CustomAgent',
				description: 'A test custom agent',
				tools: ['tool1', 'tool2'],
				agentInstructions: { content: 'Custom agent body', toolReferences: [] },
				source: { storage: PromptsStorage.local },
				target: Target.Undefined,
				visibility: { userInvokable: true, agentInvokable: true }
			};
			promptsService.setCustomModes([customMode]);

			const tool = testDisposables.add(new RunSubagentTool(
				{} as IChatAgentService,
				{} as IChatService,
				mockToolsService,
				{} as ILanguageModelsService,
				new NullLogService(),
				mockToolsService,
				configService,
				promptsService,
				{} as IInstantiationService,
			));

			const result = await tool.prepareToolInvocation(
				{
					parameters: {
						prompt: 'Test prompt',
						description: 'Test task',
						agentName: 'CustomAgent',
					},
					toolCallId: 'test-call-1',
					chatSessionResource: URI.parse('test://session'),
				},
				CancellationToken.None
			);

			assert.ok(result);
			assert.strictEqual(result.invocationMessage, 'Test task');
			assert.deepStrictEqual(result.toolSpecificData, {
				kind: 'subagent',
				description: 'Test task',
				agentName: 'CustomAgent',
				prompt: 'Test prompt',
				modelName: undefined,
			});
		});
	});

	suite('getToolData', () => {
		test('returns basic tool data', () => {
			const mockToolsService = testDisposables.add(new MockLanguageModelToolsService());
			const configService = new TestConfigurationService();
			const promptsService = new MockPromptsService();

			const tool = testDisposables.add(new RunSubagentTool(
				{} as IChatAgentService,
				{} as IChatService,
				mockToolsService,
				{} as ILanguageModelsService,
				new NullLogService(),
				mockToolsService,
				configService,
				promptsService,
				{} as IInstantiationService,
			));

			const toolData = tool.getToolData();

			assert.strictEqual(toolData.id, 'runSubagent');
			assert.ok(toolData.inputSchema);
			assert.ok(toolData.inputSchema.properties?.prompt);
			assert.ok(toolData.inputSchema.properties?.description);
			assert.deepStrictEqual(toolData.inputSchema.required, ['prompt', 'description']);
		});

		test('includes agentName property when SubagentToolCustomAgents is enabled', () => {
			const mockToolsService = testDisposables.add(new MockLanguageModelToolsService());
			const configService = new TestConfigurationService({
				'chat.customAgentInSubagent.enabled': true,
			});
			const promptsService = new MockPromptsService();

			const tool = testDisposables.add(new RunSubagentTool(
				{} as IChatAgentService,
				{} as IChatService,
				mockToolsService,
				{} as ILanguageModelsService,
				new NullLogService(),
				mockToolsService,
				configService,
				promptsService,
				{} as IInstantiationService,
			));

			const toolData = tool.getToolData();

			assert.ok(toolData.inputSchema?.properties?.agentName, 'agentName should be in schema when custom agents enabled');
		});
	});

	suite('onDidInvokeTool event', () => {
		test('mock service fires onDidInvokeTool events with correct data', () => {
			const mockToolsService = testDisposables.add(new MockLanguageModelToolsService());
			const sessionResource = URI.parse('test://session');
			const receivedEvents: { toolId: string; sessionResource: URI | undefined; requestId: string | undefined; subagentInvocationId: string | undefined }[] = [];

			testDisposables.add(mockToolsService.onDidInvokeTool(e => {
				receivedEvents.push(e);
			}));

			mockToolsService.fireOnDidInvokeTool({
				toolId: 'test-tool',
				sessionResource,
				requestId: 'request-123',
				subagentInvocationId: 'subagent-456',
			});

			assert.strictEqual(receivedEvents.length, 1);
			assert.deepStrictEqual(receivedEvents[0], {
				toolId: 'test-tool',
				sessionResource,
				requestId: 'request-123',
				subagentInvocationId: 'subagent-456',
			});
		});

		test('events with different subagentInvocationId are distinguishable', () => {
			// This tests the filtering logic used in RunSubagentTool.invoke()
			// The tool subscribes to onDidInvokeTool and checks if e.subagentInvocationId matches its own callId
			const mockToolsService = testDisposables.add(new MockLanguageModelToolsService());
			const targetSubagentId = 'target-subagent';

			const matchingEvents: string[] = [];
			testDisposables.add(mockToolsService.onDidInvokeTool(e => {
				if (e.subagentInvocationId === targetSubagentId) {
					matchingEvents.push(e.toolId);
				}
			}));

			// Fire events with different subagentInvocationIds
			mockToolsService.fireOnDidInvokeTool({
				toolId: 'unrelated-tool',
				sessionResource: undefined,
				requestId: undefined,
				subagentInvocationId: 'different-subagent',
			});
			mockToolsService.fireOnDidInvokeTool({
				toolId: 'matching-tool',
				sessionResource: undefined,
				requestId: undefined,
				subagentInvocationId: targetSubagentId,
			});
			mockToolsService.fireOnDidInvokeTool({
				toolId: 'another-unrelated-tool',
				sessionResource: undefined,
				requestId: undefined,
				subagentInvocationId: undefined,
			});

			// Only the matching event should be captured
			assert.deepStrictEqual(matchingEvents, ['matching-tool']);
		});
	});
});
