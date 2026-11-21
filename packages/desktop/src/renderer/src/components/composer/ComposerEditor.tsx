import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalExtensionEditorComposer } from "@lexical/react/LexicalExtensionEditorComposer";
import { type ComposerDocument, type ComposerPart, composerDocumentFromText } from "@percho/shared";
import { $getRoot, type EditorState, HISTORY_PUSH_TAG } from "lexical";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import "./composer-editor.css";
import {
	$insertComposerReferences,
	$readComposerState,
	$replaceComposerRangeWithReference,
	$replaceComposerRangeWithText,
	type ComposerEditorHandle,
	type ComposerSelection,
	setComposerSelection,
} from "./editor-document";
import { type ComposerEditorEntry, getComposerEditor, syncComposerDocument } from "./editor-host";

interface ComposerEditorProps {
	draftKey: string;
	document?: ComposerDocument;
	value?: string;
	placeholder: string;
	disabled?: boolean;
	className?: string;
	onChange: (document: ComposerDocument, completionText: string, selection: ComposerSelection) => void;
	onSelectionChange?: (completionText: string, selection: ComposerSelection) => void;
	onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
	onPaste: React.ClipboardEventHandler<HTMLDivElement>;
}

function readState(state: EditorState): {
	text: string;
	selection: ComposerSelection;
	document: ComposerDocument;
	completionText: string;
} {
	let next = {
		text: "",
		selection: { start: 0, end: 0 },
		document: { version: 1 as const, parts: [] as ComposerPart[] },
		completionText: "",
	};
	state.read(() => {
		const current = $readComposerState();
		next = {
			text: current.text,
			selection: { start: current.selectionStart, end: current.selectionEnd },
			document: current.document,
			completionText: current.completionText,
		};
	});
	return next;
}

const EditorBridge = forwardRef<
	ComposerEditorHandle,
	ComposerEditorProps & {
		entry: ComposerEditorEntry;
		resolvedDocument: ComposerDocument;
	}
>(function EditorBridge(
	{
		entry,
		resolvedDocument,
		placeholder,
		disabled = false,
		className,
		onChange,
		onSelectionChange,
		onKeyDown,
		onPaste,
	},
	ref,
) {
	const contentEditableRef = useRef<HTMLDivElement>(null);
	const latest = useRef({ onChange, onSelectionChange });
	latest.current = { onChange, onSelectionChange };

	useImperativeHandle(
		ref,
		() => ({
			get value() {
				return readState(entry.editor.getEditorState()).text;
			},
			get selectionStart() {
				return readState(entry.editor.getEditorState()).selection.start;
			},
			get selectionEnd() {
				return readState(entry.editor.getEditorState()).selection.end;
			},
			focus: (position) => {
				if (position) {
					entry.editor.update(
						() => {
							const root = $getRoot();
							if (position === "start") root.selectStart();
							else root.selectEnd();
						},
						{ discrete: true },
					);
				}
				entry.editor.focus();
			},
			getText: () => readState(entry.editor.getEditorState()).text,
			getSelection: () => readState(entry.editor.getEditorState()).selection,
			selectionRange: () => readState(entry.editor.getEditorState()).selection,
			getDocument: () => readState(entry.editor.getEditorState()).document,
			getCompletionText: () => readState(entry.editor.getEditorState()).completionText,
			setSelectionRange: (start, end) => {
				entry.editor.update(() => setComposerSelection(start, end), {
					discrete: true,
				});
			},
			replaceRange: (start, end, replacement) => {
				entry.editor.update(() => $replaceComposerRangeWithText(start, end, replacement), {
					tag: HISTORY_PUSH_TAG,
					discrete: true,
				});
			},
			replaceRangeWithReference: (start, end, reference) => {
				entry.editor.update(() => $replaceComposerRangeWithReference(start, end, reference), {
					tag: HISTORY_PUSH_TAG,
					discrete: true,
				});
				entry.editor.focus();
			},
			insertReferences: (references, range) => {
				entry.editor.update(() => $insertComposerReferences(references, range), {
					tag: HISTORY_PUSH_TAG,
					discrete: true,
				});
				entry.editor.focus();
			},
		}),
		[entry],
	);

	useLayoutEffect(() => {
		const element = contentEditableRef.current;
		if (!element) return;
		const resize = () => {
			element.style.height = "auto";
			element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
		};
		const observer = new ResizeObserver(resize);
		observer.observe(element);
		resize();
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		entry.editor.setEditable(!disabled);
	}, [entry, disabled]);

	useEffect(() => {
		return entry.editor.registerUpdateListener(({ editorState }) => {
			const next = readState(editorState);
			if (JSON.stringify(next.document) !== JSON.stringify(entry.document)) {
				entry.document = next.document;
				latest.current.onChange(next.document, next.completionText, next.selection);
			}
			if (!entry.editor.isComposing()) {
				latest.current.onSelectionChange?.(next.completionText, next.selection);
			}
		});
	}, [entry]);

	const empty = resolvedDocument.parts.length === 0;

	return (
		<div className="relative min-h-[24px] w-full">
			{empty && (
				<span className="pointer-events-none absolute inset-0 select-none text-ui-14 leading-6 text-ink-faint">
					{placeholder}
				</span>
			)}
			<ContentEditable
				ref={contentEditableRef}
				className={className ? `composer-editor ${className}` : "composer-editor"}
				aria-label={placeholder}
				aria-disabled={disabled}
				onKeyDownCapture={(event) => {
					if (event.nativeEvent.isComposing || entry.editor.isComposing()) return;
					onKeyDown(event);
					if (event.defaultPrevented) event.stopPropagation();
				}}
				onPasteCapture={(event) => {
					onPaste(event);
					if (event.defaultPrevented) event.stopPropagation();
				}}
			/>
		</div>
	);
});

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
	function ComposerEditor(props, ref) {
		const document = props.document ?? composerDocumentFromText(props.value ?? "");
		const entry = useMemo(() => getComposerEditor(props.draftKey, document), [props.draftKey, document]);
		useEffect(() => syncComposerDocument(entry, document), [entry, document]);
		return (
			<LexicalExtensionEditorComposer initialEditor={entry.editor}>
				<EditorBridge {...props} entry={entry} resolvedDocument={document} ref={ref} />
			</LexicalExtensionEditorComposer>
		);
	},
);
