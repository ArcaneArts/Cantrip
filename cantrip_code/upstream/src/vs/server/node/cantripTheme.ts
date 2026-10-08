/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ColorScheme, isDark, isHighContrast } from '../../platform/theme/common/theme.js';

const colorSchemes: Readonly<Record<string, ColorScheme>> = {
	'light': ColorScheme.LIGHT,
	'dark': ColorScheme.DARK,
	'high-contrast-light': ColorScheme.HIGH_CONTRAST_LIGHT,
	'high-contrast-dark': ColorScheme.HIGH_CONTRAST_DARK,
	'pro-light': ColorScheme.LIGHT,
	'pro-dark': ColorScheme.DARK,
	'pro-high-contrast-light': ColorScheme.HIGH_CONTRAST_LIGHT,
	'pro-high-contrast-dark': ColorScheme.HIGH_CONTRAST_DARK,
};

/**
 * Seed the workbench before asynchronous workspace/theme loading. The worker
 * supplies the session appearance; missing hints use Cantrip's dark default.
 */
export function getCantripInitialColorTheme(appearance: string | undefined) {
	const themeType = (appearance && Object.hasOwn(colorSchemes, appearance) ? colorSchemes[appearance] : undefined) ?? ColorScheme.DARK;
	const dark = isDark(themeType);
	const highContrast = isHighContrast(themeType);
	return {
		themeType,
		colors: {
			'foreground': highContrast ? (dark ? '#FFFFFF' : '#000000') : (dark ? '#E7E9ED' : '#20242A'),
			'editor.foreground': highContrast ? (dark ? '#FFFFFF' : '#000000') : (dark ? '#D9DCE2' : '#282C33'),
			'editor.background': '#00000000',
			'editorGroup.emptyBackground': '#00000000',
			'editorGroupHeader.tabsBackground': '#00000000',
			'sideBar.background': '#00000000',
			'sideBarSectionHeader.background': '#00000000',
			'activityBar.background': '#00000000',
			'titleBar.activeBackground': '#00000000',
			'titleBar.inactiveBackground': '#00000000',
			'statusBar.background': '#00000000',
			'statusBar.noFolderBackground': '#00000000',
			'panel.background': '#00000000',
			'panelSectionHeader.background': '#00000000',
			'terminal.background': '#00000000',
			'breadcrumb.background': '#00000000',
			'input.background': '#00000000',
		},
	};
}
