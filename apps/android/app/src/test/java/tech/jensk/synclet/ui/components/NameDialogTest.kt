package tech.jensk.synclet.ui.components

import androidx.compose.ui.text.TextRange
import org.junit.Assert.assertEquals
import org.junit.Test

class NameDialogTest {
    @Test fun fileSelectsTheNameWithoutExtension() {
        assertEquals(TextRange(0, 6), initialNameSelection("Report.pdf", isFolder = false))
        assertEquals(TextRange(0, 11), initialNameSelection("archive.tar.gz", isFolder = false))
    }

    @Test fun folderSelectsTheWholeName() {
        assertEquals(TextRange(0, 12), initialNameSelection("Scan 2026.10", isFolder = true))
    }

    @Test fun dotFilesAndEmptyNamesSelectEverything() {
        assertEquals(TextRange(0, 10), initialNameSelection(".gitignore", isFolder = false))
        assertEquals(TextRange(0, 0), initialNameSelection("", isFolder = true))
    }
}
