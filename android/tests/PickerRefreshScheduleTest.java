package com.lakomics.mobile;

/** Platform free checks for the Photo Picker refresh settle and interaction gate. */
public final class PickerRefreshScheduleTest {
    private static int checks;

    private static void equal(long expected, long actual, String message) {
        if(expected!=actual)throw new AssertionError(message+": expected "+expected+", got "+actual);
        checks++;
    }

    private static void startupAndInteractionAreDeferred() {
        PickerRefreshSchedule schedule=new PickerRefreshSchedule();
        schedule.resume(1_000);
        schedule.request(false,1_000);
        equal(PickerRefreshSchedule.START_DELAY,schedule.delay(1_000),"Cold foreground waits for Home to settle");
        equal(1_000,schedule.delay(30_000),"The settle window is measured from foreground");
        schedule.interaction(30_000);
        equal(PickerRefreshSchedule.IDLE_DELAY,schedule.delay(30_000),"Input restarts the idle window");
        equal(0,schedule.delay(33_000),"An idle foreground can start the walk");
    }

    public static void main(String[] args) {
        startupAndInteractionAreDeferred();
        System.out.println("PickerRefreshScheduleTest checks="+checks);
    }
}
