package tech.jensk.synclet.core.api

import tech.jensk.synclet.core.api.SearchSnippet.Segment
import org.junit.Assert.assertEquals
import org.junit.Test

class SearchSnippetTest {
    @Test fun parsesMarks() = assertEquals(
        listOf(Segment("Das ", false), Segment("Angebot", true), Segment(" für ", false), Segment("Jens", true)),
        SearchSnippet.parse("Das «Angebot» für «Jens»"))
    @Test fun plainTextIsOneSegment() = assertEquals(listOf(Segment("abc", false)), SearchSnippet.parse("abc"))
    @Test fun unbalancedOpenMark() = assertEquals(listOf(Segment("a ", false), Segment("b", true)), SearchSnippet.parse("a «b"))
}
