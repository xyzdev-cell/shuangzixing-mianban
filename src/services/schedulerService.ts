const cron = require('node-cron');
const configService = require('./configService.ts');
const batchTestService = require('./batchTestService.ts');

class SchedulerService {
    constructor() {
        this.batchTestTask = null;
        this.isInitialized = false;
    }

    /**
     * Initialize the scheduler service
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        console.log('Initializing Scheduler Service...');
        
        // Check if auto test is enabled and start the task if needed
        await this.updateBatchTestSchedule();
        
        this.isInitialized = true;
        console.log('Scheduler Service initialized.');
    }

    /**
     * Update the batch test schedule based on current settings
     */
    async updateBatchTestSchedule() {
        try {
            // Get current auto test setting
            const autoTestEnabled = await configService.getSetting('auto_test', '0');
            const isEnabled = autoTestEnabled === '1' || autoTestEnabled === 1 || autoTestEnabled === true;

            if (isEnabled) {
                await this.startBatchTestSchedule();
            } else {
                await this.stopBatchTestSchedule();
            }
        } catch (error) {
            console.error('Error updating batch test schedule:', error);
        }
    }

    /**
     * Start the batch test schedule (daily at 4 AM Beijing time)
     */
    async startBatchTestSchedule() {
        // Stop existing task if running
        if (this.batchTestTask) {
            this.batchTestTask.stop();
            this.batchTestTask = null;
        }

        // Create new cron task for 4 AM Beijing time (UTC+8)
        // This translates to 20:00 UTC (4 AM Beijing = 4 AM UTC+8 = 20:00 UTC)
        // Cron format: second minute hour day month dayOfWeek
        // '0 0 20 * * *' means every day at 20:00 UTC
        this.batchTestTask = cron.schedule('0 0 20 * * *', async () => {
            console.log('Starting scheduled batch test at 4 AM Beijing time...');
            try {
                const result = await batchTestService.runBatchTest();
                console.log('Scheduled batch test completed:', {
                    totalKeys: result.totalKeys,
                    successCount: result.successCount,
                    failureCount: result.failureCount,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.error('Error during scheduled batch test:', error);
            }
        }, {
            scheduled: true,
            timezone: 'UTC' // We calculate the UTC time manually for Beijing time
        });

        console.log('Batch test scheduled to run daily at 4 AM Beijing time (20:00 UTC)');
    }

    /**
     * Stop the batch test schedule
     */
    async stopBatchTestSchedule() {
        if (this.batchTestTask) {
            this.batchTestTask.stop();
            this.batchTestTask = null;
            console.log('Batch test schedule stopped.');
        }
    }

    /**
     * Get the current status of the scheduler
     */
    getStatus() {
        return {
            isInitialized: this.isInitialized,
            batchTestScheduled: !!this.batchTestTask,
            nextBatchTestRun: this.batchTestTask ? 'Daily at 4 AM Beijing time' : 'Not scheduled'
        };
    }

    /**
     * Manually trigger a batch test (for testing purposes)
     */
    async triggerBatchTest() {
        console.log('Manually triggering batch test...');
        try {
            const result = await batchTestService.runBatchTest();
            console.log('Manual batch test completed:', {
                totalKeys: result.totalKeys,
                successCount: result.successCount,
                failureCount: result.failureCount,
                timestamp: new Date().toISOString()
            });
            return result;
        } catch (error) {
            console.error('Error during manual batch test:', error);
            throw error;
        }
    }

    /**
     * Shutdown the scheduler service
     */
    async shutdown() {
        console.log('Shutting down Scheduler Service...');
        
        if (this.batchTestTask) {
            this.batchTestTask.stop();
            this.batchTestTask = null;
        }
        
        this.isInitialized = false;
        console.log('Scheduler Service shut down.');
    }
}

// Create singleton instance
const schedulerService = new SchedulerService();

module.exports = schedulerService;

