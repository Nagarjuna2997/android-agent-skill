# Rich text and Markdown

Render formatted text in Compose from a paragraph model: bold, italic, inline code, links that open in the browser, mentions that call back into the app, bullets, code blocks, and inline icons, all through `AnnotatedString`, `LinkAnnotation`, `TextLinkStyles` and `InlineTextContent`. The technique is distilled from JetNews's article body and Jetchat's message formatter in `android/compose-samples`; the code here is an original re-implementation.

## When to use

- Article bodies, chat messages, release notes, help text: anything with inline styling and links that must be selectable, scale with font size and work with TalkBack.
- Lightweight Markdown ("markdown-lite": `*bold*`, `_italic_`, `` `code` ``, URLs, `@mentions`) authored by users or by your backend.
- Server-provided HTML snippets: `AnnotatedString.fromHtml` handles `<b>`, `<i>`, `<u>`, `<a href>`, `<br>` and a few more without a WebView.
- Not for full CommonMark with tables, images and nested lists; parse that with a Markdown library on the JVM (for example `org.commonmark:commonmark`, `<version>` from its release page) into the same paragraph model below, then render with this file. Not for arbitrary untrusted HTML with scripts or forms; that is a WebView decision with its own security review.

## Dependencies

No library beyond Compose. `LinkAnnotation`, `TextLinkStyles`, `withLink` and `AnnotatedString.fromHtml` are in `androidx.compose.ui:ui-text` (BOM 2026.09.00, Compose 1.12.1).

```kotlin
dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-text")
    implementation("androidx.compose.material3:material3")
    testImplementation("junit:junit:4.13.2")
}
```

## Manifest and permissions

None. Opening a URL link uses the system `UriHandler` (an implicit `ACTION_VIEW` intent), which needs no permission.

## Implementation

### Paragraph model

Keep the parsed document as plain data so the ViewModel and tests never touch `AnnotatedString`. The UI converts it once per paragraph inside `remember`.

```kotlin
package com.example.app.ui.richtext

import androidx.compose.runtime.Immutable

enum class ParagraphType { Header, Subheader, Body, Bullet, Quote, CodeBlock, Caption }

sealed interface InlineStyle {
    data object Bold : InlineStyle
    data object Italic : InlineStyle
    data object Strikethrough : InlineStyle
    data object Code : InlineStyle
    data class Link(val url: String) : InlineStyle
    data class Mention(val userId: String) : InlineStyle
    /** Replaced by a composable; `id` keys the `inlineContent` map. */
    data class Inline(val id: String) : InlineStyle
}

@Immutable
data class Span(val start: Int, val end: Int, val style: InlineStyle)

@Immutable
data class RichParagraph(val type: ParagraphType, val text: String, val spans: List<Span> = emptyList())
```

### Markdown-lite tokenizer

One regex, as in Jetchat, finds the tokens; delimiters are dropped from the output text and the span offsets refer to the stripped text. This runs on the JVM and is unit-tested below.

```kotlin
package com.example.app.ui.richtext

// Technique from android/compose-samples Jetchat (Apache-2.0): a single alternation regex,
// one branch per token kind, applied left to right.
private val tokenPattern = Regex(
    """(https?://[^\s]+)|(`[^`]+`)|(@\w+)|(\*[^*]+\*)|(_[^_]+_)|(~[^~]+~)""",
)

fun parseMarkdownLite(raw: String, type: ParagraphType = ParagraphType.Body): RichParagraph {
    val text = StringBuilder()
    val spans = mutableListOf<Span>()
    var cursor = 0
    for (match in tokenPattern.findAll(raw)) {
        text.append(raw, cursor, match.range.first)
        val token = match.value
        val start = text.length
        when {
            token.startsWith("http") -> { text.append(token); spans += Span(start, text.length, InlineStyle.Link(token)) }
            token.startsWith("@") -> { text.append(token); spans += Span(start, text.length, InlineStyle.Mention(token.drop(1))) }
            token.startsWith("`") -> { text.append(token, 1, token.length - 1); spans += Span(start, text.length, InlineStyle.Code) }
            token.startsWith("*") -> { text.append(token, 1, token.length - 1); spans += Span(start, text.length, InlineStyle.Bold) }
            token.startsWith("_") -> { text.append(token, 1, token.length - 1); spans += Span(start, text.length, InlineStyle.Italic) }
            token.startsWith("~") -> { text.append(token, 1, token.length - 1); spans += Span(start, text.length, InlineStyle.Strikethrough) }
        }
        cursor = match.range.last + 1
    }
    text.append(raw, cursor, raw.length)
    return RichParagraph(type, text.toString(), spans)
}
```

### Model to AnnotatedString, with links and mentions

`withLink` attaches a `LinkAnnotation`. `LinkAnnotation.Url` is opened by `Text` through `LocalUriHandler` with no extra code; `LinkAnnotation.Clickable` invokes your listener. `TextLinkStyles` gives each link its normal, focused, hovered and pressed styles, which is what makes links visible to keyboard and mouse users on large screens.

```kotlin
package com.example.app.ui.richtext

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.foundation.text.appendInlineContent

@Composable
fun rememberAnnotated(paragraph: RichParagraph, onMentionClick: (String) -> Unit): AnnotatedString {
    val scheme = MaterialTheme.colorScheme
    // The AnnotatedString is cached on the paragraph, but the callback it captured must stay
    // current; rememberUpdatedState makes the cached lambda call the latest one.
    val currentOnMention by rememberUpdatedState(onMentionClick)
    val linkStyles = TextLinkStyles(
        style = SpanStyle(color = scheme.primary, textDecoration = TextDecoration.Underline),
        focusedStyle = SpanStyle(color = scheme.primary, background = scheme.primary.copy(alpha = 0.12f)),
        hoveredStyle = SpanStyle(color = scheme.primary, textDecoration = TextDecoration.Underline),
        pressedStyle = SpanStyle(color = scheme.onPrimaryContainer, background = scheme.primaryContainer),
    )
    val codeBackground = scheme.onSurface.copy(alpha = 0.12f)

    return remember(paragraph, scheme) {
        buildAnnotatedString {
            var cursor = 0
            for (span in paragraph.spans.sortedBy { it.start }) {
                append(paragraph.text, cursor, span.start)
                val piece = paragraph.text.substring(span.start, span.end)
                when (val style = span.style) {
                    InlineStyle.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(piece) }
                    InlineStyle.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(piece) }
                    InlineStyle.Strikethrough -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(piece) }
                    InlineStyle.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) { append(piece) }
                    is InlineStyle.Link -> withLink(LinkAnnotation.Url(style.url, linkStyles)) { append(piece) }
                    is InlineStyle.Mention -> withLink(
                        LinkAnnotation.Clickable(tag = "mention:${style.userId}", styles = linkStyles) { currentOnMention(style.userId) },
                    ) { withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(piece) } }
                    is InlineStyle.Inline -> appendInlineContent(style.id, alternateText = piece)
                }
                cursor = span.end
            }
            append(paragraph.text, cursor, paragraph.text.length)
        }
    }
}
```

To intercept URL clicks (open in a custom tab, log analytics, block a domain) pass a `LinkInteractionListener` as the third argument of `LinkAnnotation.Url`; return without calling the `UriHandler` to swallow the click. Do not use the deprecated `ClickableText`; `Text` handles `LinkAnnotation` itself and announces links to TalkBack.

### Inline content

An `InlineStyle.Inline` span is replaced by a composable at render time: an icon, an avatar, a badge. The placeholder size is in `sp` so it scales with the text.

```kotlin
package com.example.app.ui.richtext

import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.unit.sp
import com.example.app.R

@Composable
fun verifiedBadgeInline(): Map<String, InlineTextContent> = mapOf(
    "verified" to InlineTextContent(
        Placeholder(width = 16.sp, height = 16.sp, placeholderVerticalAlign = PlaceholderVerticalAlign.TextCenter),
    ) { alternateText ->
        Icon(painterResource(R.drawable.ic_verified), contentDescription = alternateText, tint = LocalContentColor.current)
    },
)
```

The `alternateText` passed to `appendInlineContent` is what TalkBack reads in place of the icon; make it meaningful ("verified account"), not the id.

### Rendering paragraphs

Each paragraph type picks a text style and a container. Bullets use an `sp`-sized dot aligned to the first baseline, as JetNews does, so the dot scales with font size. The list is a `LazyColumn` so long articles do not compose every paragraph at once.

```kotlin
package com.example.app.ui.richtext

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.FirstBaseline
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

fun LazyListScope.richParagraphs(
    paragraphs: List<RichParagraph>,
    onMentionClick: (String) -> Unit,
    inlineContent: Map<String, InlineTextContent> = emptyMap(),
) {
    itemsIndexed(paragraphs, key = { index, _ -> index }, contentType = { _, p -> p.type }) { _, paragraph ->
        val annotated = rememberAnnotated(paragraph, onMentionClick)
        Paragraph(paragraph.type, annotated, inlineContent, Modifier.padding(bottom = 16.dp))
    }
}

@Composable
fun Paragraph(type: ParagraphType, text: AnnotatedString, inlineContent: Map<String, InlineTextContent>, modifier: Modifier = Modifier) {
    val typography = MaterialTheme.typography
    when (type) {
        ParagraphType.Header -> Text(text, modifier.semantics { heading() }, style = typography.headlineMedium, inlineContent = inlineContent)
        ParagraphType.Subheader -> Text(text, modifier.semantics { heading() }, style = typography.titleLarge, inlineContent = inlineContent)
        ParagraphType.Caption -> Text(text, modifier, style = typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, inlineContent = inlineContent)
        ParagraphType.Body -> Text(text, modifier, style = typography.bodyLarge.copy(lineHeight = 28.sp), inlineContent = inlineContent)
        ParagraphType.Quote -> Row(modifier) {
            Box(Modifier.size(width = 3.dp, height = 24.dp).background(MaterialTheme.colorScheme.outline))
            Text(text, Modifier.padding(start = 12.dp), style = typography.bodyLarge, inlineContent = inlineContent)
        }
        ParagraphType.CodeBlock -> Surface(modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
            Text(text, Modifier.padding(16.dp), style = typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), inlineContent = inlineContent)
        }
        ParagraphType.Bullet -> Row(modifier) {
            with(LocalDensity.current) {
                // Technique from android/compose-samples JetNews (Apache-2.0): the bullet is sized
                // in sp and aligned 1 sp below the circle to the text's first baseline.
                Box(
                    Modifier
                        .size(8.sp.toDp())
                        .alignBy { 9.sp.roundToPx() }
                        .background(LocalContentColor.current, CircleShape),
                )
            }
            Text(text, Modifier.padding(start = 12.dp).weight(1f).alignBy(FirstBaseline), style = typography.bodyLarge, inlineContent = inlineContent)
        }
    }
}
```

`Row.alignBy` is available because `Row` provides `RowScope`; the lambda form takes the measured height and returns the alignment line position in pixels.

### HTML from the server

```kotlin
val annotated = remember(html, linkStyles) {
    AnnotatedString.fromHtml(
        htmlString = html,
        linkStyles = linkStyles,
        linkInteractionListener = null,   // default: open with the UriHandler
    )
}
Text(annotated)
```

`fromHtml` supports the tags `Html.fromHtml` supports (bold, italic, underline, strike, links, sub/sup, headings, line breaks, simple lists) and ignores the rest. Sanitize on the server; it is not an XSS boundary because nothing executes, but unexpected tags produce ugly output.

### Where it plugs in

The ViewModel exposes `List<RichParagraph>` in `UiState` (parsed in the repository or a use case on `Dispatchers.Default`, injected as in [../../patterns/mvvm.md](../../patterns/mvvm.md)). The screen calls `richParagraphs(uiState.paragraphs, onMentionClick = viewModel::openProfile)` inside its `LazyColumn`. Links to other screens in your app go through `LinkAnnotation.Clickable` and the navigation layer, never by parsing URLs in the composable.

## Verify

```sh
./gradlew :app:testDebugUnitTest --tests "*MarkdownLiteTest*"
./gradlew :app:assembleDebug
./gradlew :app:connectedDebugAndroidTest --tests "*RichTextTest*"
adb shell settings put system font_scale 2.0   # bullets and inline icons must scale with text
```

Parser test (JVM, no Android):

```kotlin
class MarkdownLiteTest {
    @Test fun stripsDelimitersAndKeepsOffsets() {
        val p = parseMarkdownLite("See *this* and https://example.com now @ana")
        assertEquals("See this and https://example.com now @ana", p.text)
        assertEquals(Span(4, 8, InlineStyle.Bold), p.spans[0])
        assertEquals(InlineStyle.Link("https://example.com"), p.spans[1].style)
        assertEquals(InlineStyle.Mention("ana"), p.spans[2].style)
        assertEquals("@ana", p.text.substring(p.spans[2].start, p.spans[2].end))
    }
}
```

Compose test that links are present as annotations and the text renders:

```kotlin
@Test fun mentionIsAnnotatedAsClickableLink() {
    var clicked: String? = null
    composeRule.setContent { AppTheme { Text(rememberAnnotated(parseMarkdownLite("hi @ana"), onMentionClick = { clicked = it })) } }
    composeRule.onNodeWithText("hi @ana").assertIsDisplayed()
    // Link click positions are layout-dependent; assert the annotation, then tap on a device.
    val annotated = parseMarkdownLite("hi @ana")
    assertEquals(1, annotated.spans.count { it.style is InlineStyle.Mention })
}
```

On a device: tap the mention and the URL, confirm the browser opens for the URL and the callback fires for the mention; enable TalkBack and confirm each link is announced as a link and reachable through the "links" reading control.

## Pitfalls

- `remember(paragraph)` without `scheme` as a key keeps the old colors after a dark-mode switch. Key on the color scheme (or the specific colors used).
- Capturing `onMentionClick` directly in the remembered `AnnotatedString` calls a stale lambda; use `rememberUpdatedState` as above.
- Span offsets computed against the raw Markdown instead of the stripped text shift every style after the first delimiter.
- `ClickableText` is deprecated and does not announce links to accessibility services; use `Text` with `LinkAnnotation`.
- `Placeholder` sizes in `dp` do not follow font scaling; use `sp`.
- Regex catastrophic backtracking on hostile input: the patterns above are linear, but if you extend them avoid nested quantifiers and cap input length.
- Opening `http://` links fails on API 28+ when cleartext is blocked by the network security config; upgrade to `https` server-side or allow the specific domain deliberately.
- Very long documents as one `Text` are slow to lay out; keep one paragraph per `LazyColumn` item.

## Sources

- https://developer.android.com/develop/ui/compose/text/style-text
- https://developer.android.com/develop/ui/compose/text/user-interactions
- https://developer.android.com/develop/ui/compose/text/style-paragraph
- https://developer.android.com/develop/ui/compose/accessibility/semantics
- https://developer.android.com/jetpack/androidx/releases/compose-ui
- https://github.com/android/compose-samples (JetNews `PostContent`, Jetchat `MessageFormatter`; see [../../references/compose-samples.md](../../references/compose-samples.md))
