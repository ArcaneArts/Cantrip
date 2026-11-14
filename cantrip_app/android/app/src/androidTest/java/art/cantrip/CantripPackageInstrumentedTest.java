package art.cantrip;

import static org.junit.Assert.assertEquals;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class CantripPackageInstrumentedTest {

    @Test
    public void targetsTheCantripApplication() {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();

        assertEquals("art.cantrip", appContext.getPackageName());
    }
}
