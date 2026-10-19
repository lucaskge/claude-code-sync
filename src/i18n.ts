/**
 * Tradução das mensagens exibidas ao usuário.
 *
 * O texto-fonte é sempre em inglês, com marcadores {0}, {1}... para os valores; as traduções ficam em
 * l10n/bundle.l10n.<idioma>.json, indexadas pelo texto em inglês. Os serviços não dependem do VS Code (para serem
 * testados isoladamente): a extensão liga `t` ao vscode.l10n na ativação; sem isso, o texto em inglês é usado.
 */

export type L10nArg = string | number | boolean;
export type Translator = (message: string, ...args: L10nArg[]) => string;

let translator: Translator = format;

export function setTranslator(fn: Translator): void {
  translator = fn;
}

export function t(message: string, ...args: L10nArg[]): string {
  return translator(message, ...args);
}

function format(message: string, ...args: L10nArg[]): string {
  return message.replace(/\{(\d+)\}/g, (match, index: string) => (Number(index) < args.length ? String(args[Number(index)]) : match));
}
