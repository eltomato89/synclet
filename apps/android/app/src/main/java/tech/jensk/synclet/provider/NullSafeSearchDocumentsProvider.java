package tech.jensk.synclet.provider;

import android.database.Cursor;
import android.os.Bundle;
import android.provider.DocumentsProvider;

import androidx.annotation.Nullable;

import java.io.FileNotFoundException;

/**
 * The framework declares the Bundle search arguments non-null, yet a caller can send none. In Kotlin an override
 * with that signature would throw a parameter NullPointerException before any of its code runs; this shim hands the
 * arguments on as nullable.
 */
public abstract class NullSafeSearchDocumentsProvider extends DocumentsProvider {
    @Override
    public final Cursor querySearchDocuments(String rootId, @Nullable String[] projection, @Nullable Bundle queryArgs)
            throws FileNotFoundException {
        return searchDocuments(rootId, projection, queryArgs);
    }

    protected abstract Cursor searchDocuments(String rootId, @Nullable String[] projection, @Nullable Bundle queryArgs)
            throws FileNotFoundException;
}
